import type { ModelExecutionAudit, SimulationState, WorldDeltaOperation, WorldEvent } from "../contracts/model";
import type { RulePackageRegistry } from "../mechanics/rule-package";
import { deriveConditionAdvance } from "../mechanics/condition-time";
import { evaluateCausalAssertion } from "../mechanics/causality";
import { contentHash } from "../models/model-audit";
import type { StructuredModelProvider } from "../models/model-provider";
import { defineAlgorithmManifest, algorithmRef, WORLD_STEP_CANDIDATE_SCHEMA_VERSION, WORLD_STEP_PREPARATION_SCHEMA_VERSION,
  StepPreparationInvalidatedError, WorldQuiescentError, type BootstrapInput, type ExecutionContext, type ExternalReactionInput,
  type WorldExecutionAlgorithm, type WorldStepInput, type WorldStepPreparation } from "../runtime/execution";
import { executionStage } from "../runtime/stages";
import { runtimeId } from "../runtime/runtime-id";
import type { JsonObject } from "../runtime/json";
import { toWorldRuntimeContract } from "../runtime/world-definition";
import { resolveEventModels, type DecisionEventModelOverrides } from "../events/model-bindings";
import { nextWorldClockBoundary } from "../events/clock-boundary";
import { captureDependencies, readDirectState, readyIntent, sealDirectState, wakeIntent } from "./state";
import type { ActionFrame, DirectStepRecord } from "./contracts";
import { DirectDecisions } from "./decisions";
import { chooseAction } from "./actions";
import { settleActions, type ActionSettlement } from "./world";
import { directPerception } from "./perception";
import { commitDirectRecord, directCandidate, sealDirectRecord } from "./canonical";

export interface DirectWorldConfig extends DecisionEventModelOverrides { creationEnabled: boolean }
export const DIRECT_WORLD_CONFIG: DirectWorldConfig = { decision: null, creation: null, fallback: null, creationEnabled: true };
export const directWorldManifest = (config = DIRECT_WORLD_CONFIG) => defineAlgorithmManifest({ id: "direct-world", version: "1", config: config as unknown as JsonObject });
export const directWorldAlgorithmRef = (config = DIRECT_WORLD_CONFIG) => algorithmRef(directWorldManifest(config));

function components(frames: ActionFrame[]): ActionFrame[][] {
  const groups: Array<{ keys: Set<string>; frames: ActionFrame[] }> = [];
  for (const frame of frames) {
    const keys = new Set([frame.actorEntityId, frame.targetEntityId, frame.toolEntityId].filter((id): id is string => id !== null));
    const touching = groups.filter(group => [...keys].some(key => group.keys.has(key)));
    const merged = { keys: new Set([...keys, ...touching.flatMap(group => [...group.keys])]), frames: [...touching.flatMap(group => group.frames), frame] };
    for (const group of touching) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups.map(group => group.frames);
}
export class DirectWorldAlgorithm implements WorldExecutionAlgorithm {
  readonly manifest;
  constructor(readonly provider: StructuredModelProvider, readonly config: DirectWorldConfig = DIRECT_WORLD_CONFIG, readonly rulePackages?: RulePackageRegistry) {
    this.manifest = directWorldManifest(config);
  }
  async bootstrap(input: Readonly<BootstrapInput>, context: ExecutionContext) {
    const registryHash = context.modelScope.modelRegistrySnapshotHash ?? (await this.provider.modelRegistryDiagnostics?.())?.registry.currentHash;
    if (!registryHash) throw new Error("direct runtime requires the captured model registry");
    const modelOverrides = { decision: this.config.decision, creation: this.config.creation, fallback: this.config.fallback };
    const control = sealDirectState({ kind: "direct-world", version: 1, worldHash: input.state.worldHash,
      modelCatalogHash: this.provider.catalog.hash, registryHash, models: resolveEventModels(input.definition.modelProfiles, modelOverrides), modelOverrides,
      intents: Object.fromEntries(Object.keys(input.state.agents).sort().map(id => [id, readyIntent()])),
      activities: [], capabilities: [], cache: [], dependencies: {}, completedSubmissionIds: [] });
    return { schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION, sourceStateHash: contentHash(input.state), agentCommits: [], modelAudits: [],
      diagnostics: { activatedAgentIds: [], reusedAgentIds: Object.keys(input.state.agents), mindFallbackAgentIds: [] },
      directWorld: { version: 1 as const, producer: algorithmRef(this.manifest), authorityHash: contentHash(toWorldRuntimeContract(input.definition)), control } };
  }
  async prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext): Promise<WorldStepPreparation> {
    const source = input.state;
    if (!source.executionState) throw new Error("bootstrap the direct world before advancing");
    const initial = readDirectState(source.executionState, source), control = structuredClone(initial);
    const authority = toWorldRuntimeContract(input.definition);
    for (const id of Object.keys(source.agents)) control.intents[id] ??= readyIntent("admitted");
    const decisions = new DirectDecisions(this.provider, control, { ...context.modelScope,
      runtimeIdentity: { worldHash: source.worldHash, revision: source.revision }, modelRegistrySnapshotHash: control.registryHash });
    const audits: ModelExecutionAudit[] = [], reads: Record<string, string> = {}, activatedAgentIds: string[] = [];
    for (const frame of control.activities) if (input.policyRoster[frame.actorId]?.kind === "idle") {
      control.intents[frame.actorId]!.status = "waiting"; control.intents[frame.actorId]!.activityId = null;
    }
    control.activities = control.activities.filter(frame => input.policyRoster[frame.actorId]?.kind !== "idle");
    for (const [id, intent] of Object.entries(control.intents)) if (intent.wait?.untilSeconds !== null && intent.wait?.untilSeconds !== undefined &&
      intent.wait.untilSeconds <= source.truth.elapsedSeconds) wakeIntent(control, id, "deadline");
    await context.stages?.before(executionStage("action-compilation"));
    const submissions = input.request.externalActions.filter(action => !control.completedSubmissionIds.includes(action.submissionId));
    if (new Set(submissions.map(action => action.agentId)).size !== submissions.length) throw new Error("duplicate external actor");
    for (const action of submissions) {
      if (input.policyRoster[action.agentId]?.kind !== "external") throw new Error("external action has no controlling participant");
      const activity = control.activities.find(frame => frame.actorId === action.agentId);
      if (activity?.temporalProfileId && !source.truth.mechanics.temporalProfiles[activity.temporalProfileId]?.interruptible) throw new Error("activity cannot be interrupted");
      control.activities = control.activities.filter(frame => frame.actorId !== action.agentId);
      control.intents[action.agentId] = { ...control.intents[action.agentId]!, status: "ready", activityId: null, wakeReasons: ["player-action"] };
    }
    const ready = Object.entries(control.intents).filter(([id, intent]) => input.policyRoster[id]?.kind === "model" && intent.status === "ready");
    const reactions = ready.filter(([, intent]) => intent.causeActionId !== null);
    // A submitted player action does not wait for unrelated initial NPC work.
    const owners = submissions.length ? submissions.map(action => action.agentId) : (reactions.length ? reactions : ready).map(([id]) => id);
    const selected = await Promise.allSettled(owners.map(async agentId => ({ agentId,
      result: await chooseAction({ state: source, definition: authority, control, decisions, agentId,
        external: submissions.find(action => action.agentId === agentId), creationEnabled: this.config.creationEnabled }) })));
    selected.forEach((result, index) => {
      const id = owners[index]!; activatedAgentIds.push(id);
      if (result.status === "fulfilled") {
        audits.push(...result.value.result.audits); Object.assign(reads, result.value.result.reads);
        if (result.value.result.frame) control.activities.push(result.value.result.frame);
      } else {
        const intent = control.intents[id]!;
        intent.status = "failed"; intent.activityId = null; intent.wakeReasons = [];
        intent.failure = { inputHash: contentHash({ agent: source.agents[id], submission: submissions.find(action => action.agentId === id) ?? null }),
          message: result.reason instanceof Error ? result.reason.message : String(result.reason), recoverable: true };
        if (result.reason?.audit) audits.push(result.reason.audit);
      }
    });
    await context.stages?.after(executionStage("action-compilation"));
    await context.stages?.before(executionStage("reaction-perception"));
    await context.stages?.after(executionStage("reaction-perception"));
    await context.stages?.before(executionStage("temporal-dependency"));
    const clock = nextWorldClockBoundary(source);
    const boundaries = [...control.activities.map(frame => frame.dueAtSeconds), ...(clock === null ? [] : [clock]),
      ...Object.values(control.intents).flatMap(intent => intent.wait?.untilSeconds !== null && intent.wait?.untilSeconds !== undefined ? [intent.wait.untilSeconds] : [])];
    const atSeconds = boundaries.length ? Math.min(...boundaries) : source.truth.elapsedSeconds;
    const due = control.activities.filter(frame => frame.dueAtSeconds === atSeconds);
    await context.stages?.after(executionStage("temporal-dependency"));
    await context.stages?.before(executionStage("truth-resolution"));
    const groups = components(due), settlements: ActionSettlement[] = [];
    const adjudicated = await Promise.allSettled(groups.map(group => settleActions(source, authority, group, decisions)));
    adjudicated.forEach((result, index) => {
      if (result.status === "fulfilled") { settlements.push(...result.value.settlements); Object.assign(reads, result.value.reads); }
      else for (const frame of groups[index]!) {
        const intent = control.intents[frame.actorId]!; intent.status = "failed"; intent.activityId = null;
        intent.failure = { inputHash: frame.inputHash, message: result.reason instanceof Error ? result.reason.message : String(result.reason), recoverable: true };
      }
    });
    settlements.sort((a, b) => a.frame.id.localeCompare(b.frame.id));
    const completed = settlements.map(item => item.frame), completedActionIds = completed.map(frame => frame.id);
    control.activities = control.activities.filter(frame => !due.some(item => item.id === frame.id));
    const clockDue = clock !== null && clock === atSeconds;
    const effectiveTime = completed.length || clockDue ? atSeconds : source.truth.elapsedSeconds;
    const step = source.step + Number(effectiveTime > source.truth.elapsedSeconds);
    const events: WorldEvent[] = settlements.map((settlement, index) => ({
      id: runtimeId({ worldHash: source.worldHash, revision: source.revision + 1, kind: "event", stage: "direct-world", owner: settlement.frame.actorId, round: 0, ordinal: index }),
      step, description: `${settlement.frame.proposal.rawText}：${settlement.outcome.summary}`, impact: "ordinary", causes: [{ kind: "action", id: settlement.frame.id }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: effectiveTime }] }));
    const timerUpdates = structuredClone(source.truth.timers);
    for (const timer of Object.values(timerUpdates)) if (timer.status === "scheduled" && timer.dueAtSeconds === effectiveTime) {
      const timed = { ...source, truth: { ...source.truth, elapsedSeconds: effectiveTime } } as SimulationState;
      timer.status = timer.assertions.every(assertion => evaluateCausalAssertion(timed, assertion).passed) ? "fired" : "cancelled";
      Object.assign(reads, captureDependencies(source, [`timer:${timer.id}`]));
      if (timer.status === "fired") for (const id of timer.wakeAgentIds) wakeIntent(control, id, `timer:${timer.id}`);
    }
    for (const settlement of settlements) {
      const { frame, outcome } = settlement, intent = control.intents[frame.actorId]!;
      intent.activityId = null; intent.status = "waiting"; intent.wait = { entityIds: frame.targetEntityId ? [frame.targetEntityId] : [], untilSeconds: null, reason: "action-settled" };
      intent.recentOutcomeIds = [outcome.id]; intent.causeActionId = null;
      if (frame.submissionId) control.completedSubmissionIds.push(frame.submissionId);
    }
    const perception = directPerception(source, settlements, events, step);
    for (const observation of perception.observations) {
      const owner = source.agents[observation.observerId]!;
      const index = events.findIndex(event => observation.sourceEventIds.includes(event.id)); const frame = settlements[index]?.frame;
      if (frame && frame.actorId !== owner.id && !Object.values(owner.belief.evidence).some(evidence =>
        evidence.step === owner.observationCursorStep && evidence.description === observation.summary)) wakeIntent(control, owner.id, "observation", frame.id);
    }
    const operations: WorldDeltaOperation[] = settlements.flatMap(settlement => settlement.operations);
    if (effectiveTime > source.truth.elapsedSeconds) {
      const causes = events.length ? [{ kind: "event" as const, id: events[0]!.id }] : Object.values(source.truth.timers).filter(timer => timer.dueAtSeconds === effectiveTime).flatMap(timer => timer.causes);
      if (!causes.length) causes.push(...Object.values(source.truth.conditions).flatMap(condition => condition.provenance));
      operations.push(...deriveConditionAdvance({ state: source, endElapsedSeconds: effectiveTime, causes }));
      operations.push({ kind: "advance_time", seconds: effectiveTime - source.truth.elapsedSeconds, causes,
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: source.truth.elapsedSeconds }] });
    }
    await context.stages?.after(executionStage("truth-resolution"));
    await context.stages?.before(executionStage("transition-causal-verification"));
    const record = sealDirectRecord({ version: 1, id: "", baseRevision: source.revision, producerHash: this.manifest.hash,
      authorityHash: contentHash(authority), reads, atSeconds: effectiveTime, frames: completed, completedActionIds,
      control: sealDirectState(control), operations, events, outcomes: settlements.map(item => item.outcome), ...perception,
      characterPatches: [], decisions: decisions.uses, modelAudits: [...decisions.audits(), ...audits], rng: source.truth.rng, timerUpdates });
    if (!operations.length && contentHash(initial) === contentHash(record.control)) throw new WorldQuiescentError(Object.entries(control.intents).flatMap(([ownerId, intent]) =>
      intent.failure ? [{ ownerId, phase: "direct-decision", ...intent.failure, reason: intent.failure.message }] : []));
    await context.stages?.after(executionStage("transition-causal-verification"));
    const body = { schemaVersion: WORLD_STEP_PREPARATION_SCHEMA_VERSION, sourceStateHash: contentHash(source), algorithmManifestHash: this.manifest.hash,
      policyRosterHash: contentHash(input.policyRoster), requestHash: contentHash(input.request), executionState: { producerHash: this.manifest.hash, data: record.control as unknown as JsonObject },
      onsetPerception: { targets: [], receipts: [], requests: [], checks: [], commitmentRounds: [], rng: source.truth.rng },
      reactionRequests: [], pendingReactionRequests: [], preparedReactionDecisions: [], modelAudits: record.modelAudits,
      payload: { record, activatedAgentIds } as unknown as JsonObject };
    return { ...body, id: contentHash(body) };
  }
  async completeStep(input: Readonly<WorldStepInput>, preparation: Readonly<WorldStepPreparation>, reactions: readonly ExternalReactionInput[], context: ExecutionContext) {
    const { id, ...body } = preparation;
    if (id !== contentHash(body) || preparation.sourceStateHash !== contentHash(input.state) || reactions.length ||
      preparation.requestHash !== contentHash(input.request) || preparation.policyRosterHash !== contentHash(input.policyRoster)) throw new StepPreparationInvalidatedError();
    await context.stages?.before(executionStage("observation-agent-mind"));
    const record = preparation.payload.record as unknown as DirectStepRecord;
    const { committed } = commitDirectRecord(input.state, record);
    await context.stages?.after(executionStage("observation-agent-mind"));
    return directCandidate(input.state, record, committed, preparation.payload.activatedAgentIds as string[]);
  }
}
