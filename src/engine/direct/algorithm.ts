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
import { resolveCapabilityModels, type CapabilityModelOverrides } from "../models/capability-bindings";
import { nextWorldClockBoundary } from "./clock";
import { captureDependencies, readDependency, readDirectState, readyIntent, sealDirectState, wakeIntent } from "./state";
import type { ActionFrame, DirectCognitiveUpdate, DirectStepRecord } from "./contracts";
import { DirectDecisions } from "./decisions";
import { chooseAction } from "./actions";
import { prepareActions } from "./world";
import { settlePreparedActions } from "./settlement";
import { activityBoundary, admitActivities } from "./activities";
import { directPerception } from "./perception";
import { commitDirectRecord, directCandidate, sealDirectRecord } from "./canonical";

export interface DirectWorldConfig extends CapabilityModelOverrides { creationEnabled: boolean }
export const DIRECT_WORLD_CONFIG: DirectWorldConfig = { decision: null, creation: null, fallback: null, creationEnabled: true };
export const directWorldManifest = (config = DIRECT_WORLD_CONFIG) => defineAlgorithmManifest({ id: "direct-world", version: "2", config: config as unknown as JsonObject });
export const directWorldAlgorithmRef = (config = DIRECT_WORLD_CONFIG) => algorithmRef(directWorldManifest(config));

function components(state: Readonly<SimulationState>, frames: ActionFrame[]): ActionFrame[][] {
  const groups: Array<{ keys: Set<string>; frames: ActionFrame[] }> = [];
  for (const frame of frames) {
    const keys = new Set([frame.actorEntityId, frame.targetEntityId, frame.toolEntityId].filter((id): id is string => id !== null));
    const places = new Set<string>();
    for (const id of keys) { let current: string | null = id; while (current && !places.has(current)) { places.add(current); current = state.truth.placements[current] ?? null; } }
    for (const pool of Object.values(state.truth.sharedActivityResourcePools)) if (places.has(pool.entityId)) keys.add(`pool:${pool.id}`);
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
      modelCatalogHash: this.provider.catalog.hash, registryHash, models: resolveCapabilityModels(input.definition.modelProfiles, modelOverrides), modelOverrides,
      intents: Object.fromEntries(Object.keys(input.state.agents).sort().map(id => [id, readyIntent()])),
      activities: [], prepared: {}, capabilities: [], cache: [], dependencies: {}, completedSubmissionIds: [] });
    return { schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION, sourceStateHash: contentHash(input.state), agentCommits: [], modelAudits: [],
      diagnostics: { activatedAgentIds: [], reusedAgentIds: Object.keys(input.state.agents), mindFallbackAgentIds: [] },
      directWorld: { version: 1 as const, producer: algorithmRef(this.manifest), authorityHash: contentHash(toWorldRuntimeContract(input.definition)), control,
        modelCatalog: this.provider.catalog.snapshot() } };
  }
  async prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext): Promise<WorldStepPreparation> {
    const source = input.state;
    if (!source.executionState) throw new Error("bootstrap the direct world before advancing");
    const initial = readDirectState(source.executionState, source), control = structuredClone(initial);
    if (control.modelCatalogHash !== this.provider.catalog.hash) throw new Error("instance model catalog differs from its pinned configuration");
    const authority = toWorldRuntimeContract(input.definition);
    for (const id of Object.keys(source.agents)) control.intents[id] ??= readyIntent("admitted");
    const decisions = new DirectDecisions(this.provider, control, { ...context.modelScope,
      runtimeIdentity: { worldHash: source.worldHash, revision: source.revision }, modelRegistrySnapshotHash: control.registryHash });
    const audits: ModelExecutionAudit[] = [], reads: Record<string, string> = {}, activatedAgentIds: string[] = [], cognition: DirectCognitiveUpdate[] = [];
    for (const frame of control.activities) if (input.policyRoster[frame.actorId]?.kind === "idle") {
      control.intents[frame.actorId]!.status = "waiting"; control.intents[frame.actorId]!.activityId = null;
    }
    control.activities = control.activities.filter(frame => input.policyRoster[frame.actorId]?.kind !== "idle");
    for (const id of Object.keys(control.prepared)) if (!control.activities.some(frame => frame.id === id)) delete control.prepared[id];
    for (const [id, intent] of Object.entries(control.intents)) if (["waiting", "failed"].includes(intent.status) &&
      Object.entries(intent.dependencies).some(([key, hash]) => key !== "clock" && !key.startsWith("agent:") && contentHash(readDependency(source, key)) !== hash)) {
      wakeIntent(control, id, "dependency-changed");
    }
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
      if (activity) delete control.prepared[activity.id];
      control.intents[action.agentId] = { ...control.intents[action.agentId]!, status: "ready", activityId: null, wakeReasons: ["player-action"], noProgressCount: 0, activeSubmission: action };
    }
    const ready = Object.entries(control.intents).filter(([id, intent]) => input.policyRoster[id]?.kind === "model" && intent.status === "ready")
      .sort(([a, left], [b, right]) => right.urgency - left.urgency || a.localeCompare(b));
    const reactions = ready.filter(([, intent]) => intent.causeActionId !== null);
    const pendingPlayers = Object.entries(control.intents).filter(([id, intent]) => input.policyRoster[id]?.kind === "external" && intent.status === "ready" && intent.activeSubmission).map(([id]) => id);
    // A submitted player action does not wait for unrelated initial NPC work.
    const owners = submissions.length ? submissions.map(action => action.agentId) : reactions.length ? reactions.map(([id]) => id)
      : pendingPlayers.length ? pendingPlayers : ready.map(([id]) => id);
    const selected = await Promise.allSettled(owners.map(async agentId => ({ agentId,
      result: await chooseAction({ state: source, definition: authority, control, decisions, agentId,
        external: submissions.find(action => action.agentId === agentId) ?? control.intents[agentId]!.activeSubmission ?? undefined, creationEnabled: this.config.creationEnabled }) })));
    selected.forEach((result, index) => {
      const id = owners[index]!; activatedAgentIds.push(id);
      if (result.status === "fulfilled") {
        audits.push(...result.value.result.audits); Object.assign(reads, result.value.result.reads);
        if (result.value.result.cognition) cognition.push(result.value.result.cognition);
        if (result.value.result.frame) control.activities.push(result.value.result.frame);
      } else {
        const intent = control.intents[id]!;
        intent.status = "failed"; intent.activityId = null; intent.wakeReasons = [];
        intent.failure = { inputHash: contentHash({ agent: source.agents[id], submission: submissions.find(action => action.agentId === id) ?? null }),
          message: (result.reason instanceof Error ? result.reason.message || result.reason.name : String(result.reason)) || "Model task failed without a diagnostic message", recoverable: true };
        if (result.reason?.audit) audits.push(result.reason.audit);
        if (result.reason?.audits) audits.push(...result.reason.audits);
      }
    });
    await context.stages?.after(executionStage("action-compilation"));
    await context.stages?.before(executionStage("reaction-perception"));
    await context.stages?.after(executionStage("reaction-perception"));
    await context.stages?.before(executionStage("temporal-dependency"));
    // Adjudicate once, then retain executable effects across intervening clock boundaries.
    for (const frame of control.activities.filter(frame => frame.kind === "reflect")) {
      control.prepared[frame.id] = { actionId: frame.id, reads: {},
        status: "succeeded", summary: "你复核了自己已有的记录。", operations: [], visibleFactIds: [], visibleEntityIds: [], namedEntityIds: [],
        deliveredToEntityIds: [], randomRequests: [], randomBindings: [], sharedClaims: [], ongoing: false, requestProgress: "complete" };
    }
    const needsPreparation = control.activities.filter(frame => frame.kind !== "reflect" && frame.activityStatus !== "paused" && frame.dueAtSeconds !== null &&
      (!control.prepared[frame.id] || Object.entries(control.prepared[frame.id]!.reads).some(([key, hash]) => contentHash(readDependency(source, key)) !== hash)));
    const groups = components(source, needsPreparation);
    const adjudicated = await Promise.allSettled(groups.map(group => prepareActions(source, authority, group, decisions, this.config.creationEnabled)));
    let newRandomCommitment = false;
    adjudicated.forEach((result, index) => {
      if (result.status === "fulfilled") {
        audits.push(...result.value.audits);
        for (const prepared of result.value.prepared) { control.prepared[prepared.actionId] = prepared; newRandomCommitment ||= prepared.randomRequests.length > 0; }
        Object.assign(reads, result.value.reads);
      }
      else {
        if (result.reason?.audit) audits.push(result.reason.audit);
        if (result.reason?.audits) audits.push(...result.reason.audits);
        for (const frame of groups[index]!) {
        const intent = control.intents[frame.actorId]!; intent.status = "failed"; intent.activityId = null;
        intent.failure = { inputHash: frame.inputHash, message: (result.reason instanceof Error ? result.reason.message || result.reason.name : String(result.reason)) || "Model task failed without a diagnostic message", recoverable: true };
        control.activities = control.activities.filter(activity => activity.id !== frame.id); delete control.prepared[frame.id];
        }
      }
    });
    admitActivities(source, control);
    const clock = nextWorldClockBoundary(source);
    const waits = Object.values(control.intents).flatMap(intent => intent.wait?.untilSeconds !== null && intent.wait?.untilSeconds !== undefined &&
      intent.wait.untilSeconds > source.truth.elapsedSeconds ? [intent.wait.untilSeconds] : []);
    const boundaries = [...control.activities.flatMap(activityBoundary), ...(clock === null ? [] : [clock]), ...waits];
    // Deciding to wait is a present-time control update. Return it before advancing
    // to an unrelated distant timer, so a player can act on the current feedback.
    const onlyControlWork = owners.length > 0 && control.activities.length === 0;
    const atSeconds = newRandomCommitment || onlyControlWork || !boundaries.length ? source.truth.elapsedSeconds : Math.min(...boundaries);
    const due = control.activities.filter(frame => frame.activityStatus === "active" && frame.dueAtSeconds === atSeconds);
    for (const frame of due) Object.assign(reads, control.prepared[frame.id]!.reads);
    await context.stages?.after(executionStage("temporal-dependency"));
    await context.stages?.before(executionStage("truth-resolution"));
    const { settlements, rng, randomRequests, randomResults } = settlePreparedActions(source, control, due);
    const completed = settlements.map(item => item.frame), completedActionIds = completed.map(frame => frame.id);
    const ongoing = completed.filter(frame => control.prepared[frame.id]!.ongoing && settlements.find(item => item.frame.id === frame.id)?.outcome.status === "succeeded");
    control.activities = control.activities.filter(frame => !completedActionIds.includes(frame.id) || ongoing.some(item => item.id === frame.id)).map(frame => structuredClone(frame));
    for (const frame of control.activities) {
      frame.progressSeconds = Math.max(frame.progressSeconds, atSeconds - frame.startedAtSeconds);
      if (ongoing.some(item => item.id === frame.id)) frame.dueAtSeconds = null;
    }
    const clockDue = clock !== null && clock === atSeconds;
    const effectiveTime = completed.length || clockDue || waits.includes(atSeconds) ? atSeconds : source.truth.elapsedSeconds;
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
      const changed = settlement.operations.length > 0 || frame.kind === "speak" && initial.intents[frame.actorId]?.lastActionHash !== intent.lastActionHash ||
        settlement.visibleEntities.some(entity => !Object.values(source.agents[frame.actorId]!.bindings).some(binding => binding.canonicalEntityIds.includes(entity.id))) ||
        frame.kind === "observe" && settlement.visibleFacts.some(fact => !Object.values(source.agents[frame.actorId]!.belief.claims).some(claim =>
          claim.predicate === fact.predicate && contentHash(claim.value) === contentHash(fact.value)));
      intent.noProgressCount = changed ? 0 : intent.noProgressCount + 1;
      intent.activityId = ongoing.some(item => item.id === frame.id) ? frame.id : null;
      intent.status = intent.activityId ? "active" : "waiting";
      intent.wait = { entityIds: frame.targetEntityId ? [frame.targetEntityId] : [], untilSeconds: null, reason: intent.noProgressCount >= 2 ? "no-progress" : "action-settled" };
      intent.recentOutcomeIds = [outcome.id]; intent.causeActionId = null;
      const continueSubmission = frame.submissionId && (frame.preparatoryFor || control.prepared[frame.id]!.requestProgress === "continue") &&
        ["succeeded", "partial"].includes(outcome.status) && intent.noProgressCount < 2 && !intent.activityId;
      if (frame.submissionId && !continueSubmission) { control.completedSubmissionIds.push(frame.submissionId); intent.activeSubmission = null; }
      if (continueSubmission) wakeIntent(control, frame.actorId, "submission-progress");
      const continueReaction = !frame.submissionId && frame.causeActionId && control.prepared[frame.id]!.requestProgress === "continue" &&
        ["succeeded", "partial"].includes(outcome.status) && intent.noProgressCount < 2 && !intent.activityId;
      if (continueReaction) wakeIntent(control, frame.actorId, "reaction-progress", frame.causeActionId);
      else if (!intent.activityId && input.policyRoster[frame.actorId]?.kind === "model" && intent.noProgressCount < 2 &&
        Object.values(source.agents[frame.actorId]!.character.goals).some(goal => goal.status === "active")) wakeIntent(control, frame.actorId, "action-result");
      if (!intent.activityId) delete control.prepared[frame.id];
      if (frame.capabilityId) {
        const capability = control.capabilities.find(capability => capability.id === frame.capabilityId)!;
        for (const entityId of settlement.deliveredToEntityIds) for (const agent of Object.values(source.agents)) if (agent.entityId === entityId && !capability.knownToAgentIds.includes(agent.id)) capability.knownToAgentIds.push(agent.id);
        capability.knownToAgentIds.sort();
      }
    }
    const perception = directPerception(source, settlements, events, step);
    for (const observation of perception.observations) {
      const owner = source.agents[observation.observerId]!;
      const index = events.findIndex(event => observation.sourceEventIds.includes(event.id)); const frame = settlements[index]?.frame;
      if (frame && frame.actorId !== owner.id && !Object.values(owner.belief.evidence).some(evidence =>
        evidence.step === owner.observationCursorStep && evidence.description === observation.summary)) wakeIntent(control, owner.id, "observation", frame.id);
    }
    const operations: WorldDeltaOperation[] = settlements.flatMap(settlement => settlement.operations);
    for (const operation of operations) if (operation.kind === "create_agent") {
      control.intents[operation.agent.id] = readyIntent("world-arrival");
    }
    if (effectiveTime > source.truth.elapsedSeconds) {
      const causes = events.length ? [{ kind: "event" as const, id: events[0]!.id }] : Object.values(source.truth.timers).filter(timer => timer.dueAtSeconds === effectiveTime).flatMap(timer => timer.causes);
      if (!causes.length) causes.push(...Object.values(source.truth.conditions).flatMap(condition => condition.provenance));
      if (!causes.length) causes.push({ kind: "mechanic", id: "direct-world-clock" });
      operations.push(...deriveConditionAdvance({ state: source, endElapsedSeconds: effectiveTime, causes }));
      operations.push({ kind: "advance_time", seconds: effectiveTime - source.truth.elapsedSeconds, causes,
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: source.truth.elapsedSeconds }] });
    }
    // Completion order of independent HTTP requests cannot change persisted replay identity.
    decisions.uses.sort((a, b) => a.result.inputHash.localeCompare(b.result.inputHash));
    control.capabilities.sort((a, b) => a.id.localeCompare(b.id)); control.activities.sort((a, b) => a.id.localeCompare(b.id));
    control.cache.sort((a, b) => a.key.localeCompare(b.key));
    await context.stages?.after(executionStage("truth-resolution"));
    await context.stages?.before(executionStage("transition-causal-verification"));
    const record = sealDirectRecord({ version: 1, id: "", baseRevision: source.revision, producerHash: this.manifest.hash,
      authorityHash: contentHash(authority), reads, atSeconds: effectiveTime, frames: completed, completedActionIds,
      control: sealDirectState(control), operations, events, outcomes: settlements.map(item => item.outcome), ...perception,
      characterPatches: [], cognition, decisions: decisions.uses, modelAudits: [...decisions.audits(), ...audits].sort((a, b) => contentHash(a).localeCompare(contentHash(b))),
      rng, randomRequests, randomResults, timerUpdates });
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
