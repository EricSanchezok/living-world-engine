import type { ModelExecutionAudit } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { StructuredModelProvider } from "../models/model-provider";
import { DecisionRuntime, type DecisionUse } from "../programs/decision-runtime";
import {
  defineAlgorithmManifest, algorithmRef, WORLD_STEP_CANDIDATE_SCHEMA_VERSION, WORLD_STEP_PREPARATION_SCHEMA_VERSION,
  WorldQuiescentError, StepPreparationInvalidatedError, type BootstrapInput, type ExecutionContext, type ExternalReactionInput, type WorldExecutionAlgorithm,
  type WorldStepInput, type WorldStepPreparation, type PolicyBinding,
} from "../runtime/execution";
import { executionStage } from "../runtime/stages";
import type { JsonObject } from "../runtime/json";
import { toWorldRuntimeContract } from "../runtime/world-definition";
import { adjudicateWorldPrograms } from "./adjudication";
import { reviseEventBeliefs } from "./cognition";
import { nextWorldClockBoundary } from "./clock-boundary";
import { createWorldEventCandidate, type WorldEventCandidate } from "./kernel";
import { advanceProgramControls } from "./program-control";
import { authorizeWorldRandomness, prepareWorldRandomPlan, worldRandomResources, type WorldRandomCommitment } from "./randomness";
import { worldProgramSources, worldResources, programWorldResources } from "./resources";
import { EventScheduler } from "./scheduler";
import { collectDecisionAudits, initialDecisionEventState, invocationAllocator, readDecisionEventState, sealDecisionEventState,
  type DecisionEventModels, type DecisionEventState } from "./runtime-state";
import { prepareProgramWorldWork } from "./world-control";
import { nativeCandidate } from "./canonical";
import { settleProgramWorldEvent } from "./settlement";
import type { DecisionEventStep } from "./execution-contract";
import { authorExternalAction } from "./external-action";
import { deferWorldAttempt } from "./world-recovery";
import { settleProgramActivities } from "./activities";

export interface DecisionEventConfig extends DecisionEventModels { maxDependencyRounds: number }
export const JEV_EVENT_CONFIG: DecisionEventConfig = { decision: "decision-jev", creation: "creation-deepseek",
  fallback: "decision-deepseek", maxDependencyRounds: 32 };
export const decisionEventManifest = (config: DecisionEventConfig = JEV_EVENT_CONFIG) =>
  defineAlgorithmManifest({ id: "decision-event", version: "1", config: config as unknown as JsonObject });
export const decisionEventAlgorithmRef = (config: DecisionEventConfig = JEV_EVENT_CONFIG) => algorithmRef(decisionEventManifest(config));

export { WorldQuiescentError } from "../runtime/execution";
interface PreparedNative {
  control: DecisionEventState; event: WorldEventCandidate | null; decisions: DecisionUse[]; activatedAgentIds: string[];
  activityAdmissionInput: DecisionEventStep["activityAdmissionInput"];
}

export class DecisionEventAlgorithm implements WorldExecutionAlgorithm {
  readonly manifest;
  constructor(private readonly provider: StructuredModelProvider, readonly config: DecisionEventConfig = JEV_EVENT_CONFIG) {
    this.manifest = decisionEventManifest(config);
    if (!Number.isSafeInteger(config.maxDependencyRounds) || config.maxDependencyRounds < 1) throw new Error("invalid program round budget");
    for (const profile of [config.decision, config.creation, config.fallback]) provider.catalog.profile(profile);
  }
  async bootstrap(input: Readonly<BootstrapInput>, context: ExecutionContext) {
    if (input.state.executionState) throw new Error("program bootstrap requires a new instance");
    const registryHash = context.modelScope.modelRegistrySnapshotHash ?? (await this.provider.modelRegistryDiagnostics?.())?.registry.currentHash;
    if (!registryHash) throw new Error("program bootstrap requires a captured model registry");
    const authority = toWorldRuntimeContract(input.definition);
    const initial = initialDecisionEventState(input.state, { decision: this.config.decision, creation: this.config.creation, fallback: this.config.fallback },
      this.provider.catalog.hash, registryHash);
    const allocator = invocationAllocator(initial, input.state.revision);
    const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.values(input.state.agents).map(agent => [agent.id, {
      kind: "model", agentId: agent.id, profiles: agent.modelProfiles,
    }]));
    const result = await advanceProgramControls(this.provider, input.state, initial, roster, context.modelScope, {
      maxDependencyRounds: this.config.maxDependencyRounds, nextInvocation: allocator.next,
    });
    result.control.worldResources = worldResources(input.state, authority);
    result.control.modelOrdinals = allocator.ordinals;
    const control = sealDecisionEventState(result.control);
    return { schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION, sourceStateHash: contentHash(input.state), agentCommits: [],
      modelAudits: result.modelAudits, diagnostics: { activatedAgentIds: result.activatedAgentIds, reusedAgentIds: [], mindFallbackAgentIds: [] },
      decisionEvent: { version: 1 as const, producerHash: this.manifest.hash, authority, control,
        decisions: result.decisions, modelAudits: result.modelAudits } };
  }
  async prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext): Promise<WorldStepPreparation> {
    const source = input.state;
    if (!source.executionState) throw new Error("program runtime must bootstrap before advancing");
    const initial = readDecisionEventState(source.executionState, source), allocator = invocationAllocator(initial, source.revision);
    const authority = toWorldRuntimeContract(input.definition);
    await context.stages?.before(executionStage("action-compilation"));
    const controlled = await advanceProgramControls(this.provider, source, initial, input.policyRoster, context.modelScope, {
      maxDependencyRounds: this.config.maxDependencyRounds, nextInvocation: allocator.next,
    });
    if (new Set(input.request.externalActions.map(action => action.agentId)).size !== input.request.externalActions.length) throw new Error("duplicate external actor submission");
    for (const action of input.request.externalActions) {
      if (input.policyRoster[action.agentId]?.kind !== "external") throw new Error("external action cannot control this Agent");
      const replacing = controlled.control.pending.filter(pending => pending.attempt.actorId === action.agentId);
      if (replacing.some(pending => !pending.failure && pending.bound &&
        !source.truth.mechanics.temporalProfiles[pending.bound.program.definition.timing.profileId]?.interruptible)) {
        throw new Error("the actor is completing noninterruptible work");
      }
      const cancelled = new Set(replacing.map(pending => pending.attempt.id));
      const externalSchedule = new EventScheduler(source.truth.elapsedSeconds, controlled.control.scheduler);
      for (const queued of externalSchedule.snapshot().pending) if (queued.kind === "world" &&
        cancelled.has((queued.payload as { attemptId: string }).attemptId)) externalSchedule.cancel(queued.id);
      controlled.control.scheduler = externalSchedule.snapshot();
      controlled.control.pending = controlled.control.pending.filter(pending => !cancelled.has(pending.attempt.id));
      const authored = await authorExternalAction(this.provider, source, action, { ...context.modelScope,
        runtimeIdentity: { worldHash: source.worldHash, revision: source.revision }, modelRegistrySnapshotHash: initial.registryHash,
        profileId: initial.models.creation, invocationBase: allocator.next(action.agentId, 2) });
      if (authored.audit) controlled.modelAudits.push(authored.audit);
      if (authored.status === "ready") controlled.control.pending.push({ attempt: authored.attempt, bound: null, atSeconds: null, dependencyHash: "", failure: null, recovery: null });
      else controlled.control.failures.push({ ownerId: action.agentId, phase: "utterance", inputHash: contentHash(action), reason: authored.reason, recoverable: true });
    }
    await context.stages?.after(executionStage("action-compilation"));
    await context.stages?.before(executionStage("grounding-resource-admission"));
    const prepared = await prepareProgramWorldWork(this.provider, authority, source, controlled.control, context.modelScope, allocator.next);
    await context.stages?.after(executionStage("grounding-resource-admission"));
    await context.stages?.before(executionStage("reaction-perception"));
    const control = prepared.control, decisions = [...controlled.decisions, ...prepared.decisions], audits = [...controlled.modelAudits, ...prepared.modelAudits];
    const scheduler = new EventScheduler(source.truth.elapsedSeconds, control.scheduler);
    const runtime = new DecisionRuntime(this.provider, control.decisionCache ?? undefined);
    const scoped = () => ({ ...context.modelScope, modelRegistrySnapshotHash: control.registryHash,
      runtimeIdentity: { worldHash: source.worldHash, revision: source.revision }, profileId: control.models.decision,
      fallbackProfileId: control.models.fallback, nextInvocation: () => allocator.next("world") });
    const physical = structuredClone(source);
    physical.executionState = { producerHash: this.manifest.hash, data: control as unknown as JsonObject };
    await context.stages?.after(executionStage("reaction-perception"));
    await context.stages?.before(executionStage("temporal-dependency"));
    const times = [scheduler.nextTime, nextWorldClockBoundary(physical)].filter((value): value is number => value !== null);
    const atSeconds = times.length ? Math.min(...times) : null;
    let event: WorldEventCandidate | null = null;
    const programs = atSeconds !== null && atSeconds > source.truth.elapsedSeconds
      ? control.pending.filter(pending => pending.atSeconds === atSeconds && !pending.failure && pending.bound).map(pending => pending.bound!) : [];
    const randomPlan = prepareWorldRandomPlan(physical, authority, control.worldResources, programs);
    let randomness: WorldRandomCommitment | null = null;
    let randomDeferral: string | null = null;
    let randomRejection: Parameters<typeof deferWorldAttempt>[5];
    if (randomPlan) {
      const authorized = await authorizeWorldRandomness(runtime, randomPlan, scoped());
      randomness = authorized.commitment; decisions.push(authorized.call);
      if (!authorized.call.reused) audits.push(authorized.call.result.audit);
      if (!randomness) {
        randomDeferral = `world rule awaits evidence or expansion: random applicability requires ${authorized.disposition}`;
        randomRejection = { disposition: authorized.disposition === "expand" ? "expand" : "wait",
          reads: randomPlan.reads, evidenceHash: authorized.call.evidenceHash };
      }
    }
    await context.stages?.after(executionStage("temporal-dependency"));
    await context.stages?.before(executionStage("truth-resolution"));
    const resources = randomness ? worldRandomResources(control.worldResources, randomness) : control.worldResources;
    const adjudication = programs.length && !randomDeferral ? await adjudicateWorldPrograms(runtime, programs, resources, worldProgramSources(authority, source), scoped(), { state: physical, definition: authority, randomness })
      : { records: [], evidence: [], calls: [] };
    decisions.push(...adjudication.calls); audits.push(...adjudication.calls.filter(call => !call.reused).map(call => call.result.audit));
    await context.stages?.after(executionStage("truth-resolution"));
    await context.stages?.before(executionStage("transition-causal-verification"));
    if (atSeconds !== null && atSeconds > source.truth.elapsedSeconds) {
      try {
        if (randomDeferral) throw new Error(randomDeferral);
        event = createWorldEventCandidate(physical, authority, control.worldResources, programs, adjudication, atSeconds, randomness);
      } catch (error) {
        if (!(error instanceof Error) || !/world rule awaits evidence or expansion|ambiguous world branches require expansion/u.test(error.message)) throw error;
        for (const bound of programs) {
          const pending = control.pending.find(value => value.attempt.id === bound.attempt.id)!;
          deferWorldAttempt(pending, resources, worldProgramSources(authority, source), error.message, adjudication, randomRejection);
          control.failures.push({ ownerId: bound.attempt.actorId, phase: "adjudication", inputHash: pending.dependencyHash, reason: error.message, recoverable: true });
          for (const queued of scheduler.snapshot().pending) if (queued.kind === "world" &&
            (queued.payload as { attemptId: string }).attemptId === bound.attempt.id) scheduler.cancel(queued.id);
        }
        control.scheduler = scheduler.snapshot();
        control.activities = settleProgramActivities(control.activities, [], programs.map(bound => bound.attempt.id), source.truth.elapsedSeconds);
        control.worldResources = programWorldResources(source, authority, control.activities, initial.worldResources);
      }
    }
    control.decisionCache = runtime.snapshot() as unknown as JsonObject; control.modelOrdinals = allocator.ordinals;
    const sealed = sealDecisionEventState(control);
    const progressHash = (value: DecisionEventState) => contentHash({ ...value, hash: "", modelOrdinals: null });
    if (!event && progressHash(sealed) === progressHash(initial)) throw new WorldQuiescentError(sealed.failures);
    await context.stages?.after(executionStage("transition-causal-verification"));
    const payload: PreparedNative = { control: sealed, event, decisions, activatedAgentIds: controlled.activatedAgentIds, activityAdmissionInput: prepared.activityAdmissionInput };
    const body = { executionState: { producerHash: this.manifest.hash, data: sealed as unknown as JsonObject },
      onsetPerception: { targets: [], receipts: [], requests: [], checks: [], commitmentRounds: [], rng: structuredClone(source.truth.rng) },
      reactionRequests: [], schemaVersion: WORLD_STEP_PREPARATION_SCHEMA_VERSION, sourceStateHash: contentHash(source),
      algorithmManifestHash: this.manifest.hash, policyRosterHash: contentHash(input.policyRoster), requestHash: contentHash(input.request),
      pendingReactionRequests: [], preparedReactionDecisions: [], modelAudits: collectDecisionAudits(audits),
      payload: payload as unknown as JsonObject };
    return { ...body, id: contentHash(body) };
  }
  async completeStep(input: Readonly<WorldStepInput>, preparation: Readonly<WorldStepPreparation>,
    reactions: readonly ExternalReactionInput[], context: ExecutionContext) {
    const { id, ...body } = preparation;
    if (id !== contentHash(body) || preparation.sourceStateHash !== contentHash(input.state) ||
      preparation.policyRosterHash !== contentHash(input.policyRoster) || preparation.requestHash !== contentHash(input.request) ||
      preparation.algorithmManifestHash !== this.manifest.hash || reactions.length) throw new StepPreparationInvalidatedError();
    await context.stages?.before(executionStage("observation-agent-mind"));
    const prepared = structuredClone(preparation.payload) as unknown as PreparedNative, authority = toWorldRuntimeContract(input.definition);
    const audits: ModelExecutionAudit[] = [...preparation.modelAudits], decisions = [...prepared.decisions];
    const allocator = invocationAllocator(prepared.control, input.state.revision);
    const runtime = new DecisionRuntime(this.provider, prepared.control.decisionCache ?? undefined);
    const beliefRevisions: DecisionEventStep["beliefRevisions"] = [];
    let finalControl = prepared.control;
    if (prepared.event) {
      const preview = settleProgramWorldEvent(input.state, prepared.control, prepared.event, authority, this.manifest.hash);
      const revised = await Promise.allSettled(preview.perceptionBeliefPatches.map(async patch => {
        const evidenceIds = patch.operations.flatMap(operation => operation.kind === "upsert_evidence" ? [operation.evidence.id] : []);
        return reviseEventBeliefs(runtime, preview.state, patch.agentId, evidenceIds, prepared.control.agents[patch.agentId]?.resources,
          { ...context.modelScope, modelRegistrySnapshotHash: prepared.control.registryHash,
            runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision }, profileId: prepared.control.models.decision,
            fallbackProfileId: prepared.control.models.fallback, nextInvocation: () => allocator.next(patch.agentId) });
      }));
      const errors = revised.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (errors.length) throw new AggregateError(errors, "private observation interpretation failed");
      for (const result of revised) if (result.status === "fulfilled") {
        beliefRevisions.push(result.value.revision); decisions.push(...result.value.calls);
        audits.push(...result.value.calls.filter(call => !call.reused).map(call => call.result.audit));
      }
      finalControl = settleProgramWorldEvent(input.state, prepared.control, prepared.event, authority, this.manifest.hash, beliefRevisions).control;
    }
    finalControl = sealDecisionEventState({ ...finalControl, modelOrdinals: allocator.ordinals, decisionCache: runtime.snapshot() as unknown as JsonObject });
    await context.stages?.after(executionStage("observation-agent-mind"));
    const proof: DecisionEventStep = { version: 1, authority, preparedControl: prepared.control, activityAdmissionInput: prepared.activityAdmissionInput,
      event: prepared.event, beliefRevisions, finalControl,
      decisions, modelAudits: collectDecisionAudits(audits), policyRoster: structuredClone(input.policyRoster), request: structuredClone(input.request) };
    return nativeCandidate(input.state, proof, this.manifest.hash, prepared.activatedAgentIds);
  }
}
