import type { CommittedStep, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { JsonObject } from "../runtime/json";
import { createHistoryReplayBase } from "../runtime/history-replay";
import { applyWorldDeltaOperation, validateSimulationState } from "../runtime/transaction";
import { applyObservationBindings, validateObservations } from "../cognition/observation";
import { applyBeliefPatch } from "../cognition/belief";
import { applyCharacterPatch } from "../cognition/character";
import { WORLD_STEP_CANDIDATE_SCHEMA_VERSION, finalCausalReviewContentHash, type WorldStepCandidate } from "../runtime/execution";
import type { DirectBootstrap, DirectStepRecord } from "./contracts";
import { readDependency, readDirectState } from "./state";
import { applyDirectCognition } from "./cognition";

export function applyDirectBootstrap(source: Readonly<SimulationState>, bootstrap: DirectBootstrap): SimulationState {
  if (source.revision !== 0 || source.executionState || source.history.length || bootstrap.version !== 1) throw new Error("direct bootstrap requires an initial world");
  const state = structuredClone(source) as SimulationState;
  state.historyBase ??= createHistoryReplayBase(state);
  state.executionState = { producerHash: bootstrap.producer.manifestHash, data: structuredClone(bootstrap.control) as unknown as JsonObject };
  readDirectState(state.executionState, state);
  state.bootstrapDirect = structuredClone(bootstrap);
  for (const agent of Object.values(state.agents)) agent.nextAction = null;
  validateSimulationState(state, false); return state;
}
export function sealDirectRecord(record: DirectStepRecord): DirectStepRecord {
  return { ...record, id: contentHash({ ...record, id: "" }) };
}

/** One mechanical transaction. Semantic answers are retained for inspection, never rerun during replay. */
export function commitDirectRecord(source: Readonly<SimulationState>, record: DirectStepRecord) {
  if (record.version !== 1 || record.id !== contentHash({ ...record, id: "" }) || source.revision !== record.baseRevision ||
    source.executionState?.producerHash !== record.producerHash || source.bootstrapDirect?.authorityHash !== record.authorityHash) throw new Error("direct commit identity mismatch");
  if (source.history.some(step => step.directEvent?.id === record.id)) throw new Error("direct event already committed");
  for (const [key, expected] of Object.entries(record.reads)) if (contentHash(readDependency(source, key)) !== expected) throw new Error(`stale direct read ${key}`);
  if (!Number.isSafeInteger(record.atSeconds) || record.atSeconds < source.truth.elapsedSeconds ||
    record.frames.length && record.atSeconds <= source.truth.elapsedSeconds) throw new Error("physical event time must advance");
  if (record.frames.some(frame => frame.dueAtSeconds !== record.atSeconds || frame.startedAtSeconds > source.truth.elapsedSeconds ||
    source.agents[frame.actorId]?.entityId !== frame.actorEntityId)) throw new Error("invalid direct activity boundary or owner");
  const beforeControl = readDirectState(source.executionState, source);
  if (beforeControl.activities.some(frame => frame.dueAtSeconds < record.atSeconds && !record.completedActionIds.includes(frame.id))) throw new Error("cannot pass an earlier admitted activity");
  for (const timer of Object.values(source.truth.timers)) if (timer.status === "scheduled" && timer.dueAtSeconds < record.atSeconds) throw new Error("cannot pass an earlier timer");
  const state = structuredClone(source) as SimulationState;
  state.revision += 1; if (record.atSeconds > source.truth.elapsedSeconds) state.step += 1;
  applyDirectCognition(state, record.cognition, source.step);
  for (const operation of record.operations) applyWorldDeltaOperation(state, operation);
  if (state.truth.elapsedSeconds !== record.atSeconds) throw new Error("time operations differ from the event boundary");
  state.truth.rng = structuredClone(record.rng);
  state.truth.timers = structuredClone(record.timerUpdates);
  state.truth.events.push(...structuredClone(record.events));
  validateObservations(state, record.observations, state.step);
  for (const [id, agent] of Object.entries(state.agents)) {
    const observations = record.observations.filter(packet => packet.observerId === id);
    state.agents[id] = applyObservationBindings(agent, observations);
    if (observations.length) state.agents[id]!.observationCursorStep = state.step;
    state.agents[id]!.nextAction = null;
  }
  for (const patch of record.beliefPatches) {
    const agent = state.agents[patch.agentId]; if (!agent) throw new Error("unknown belief owner");
    agent.belief = applyBeliefPatch(agent.belief, patch);
  }
  for (const patch of record.characterPatches) {
    const agent = state.agents[patch.agentId]; if (!agent) throw new Error("unknown character owner");
    agent.character = applyCharacterPatch(agent.character, agent.belief, patch, state.step,
      record.observations.filter(packet => packet.observerId === agent.id), record.events);
  }
  state.executionState = { producerHash: record.producerHash, data: structuredClone(record.control) as unknown as JsonObject };
  readDirectState(state.executionState, state);
  const payload: Omit<CommittedStep, "semanticHash" | "contentHash"> = {
    directEvent: structuredClone(record), executionState: structuredClone(state.executionState), baseRevision: source.revision, revision: state.revision, step: state.step,
    initialActions: record.frames.map(frame => frame.proposal), actions: record.frames.map(frame => frame.proposal), reactionRequests: [], reactionDecisions: [],
    rngBefore: structuredClone(source.truth.rng), rngAfter: structuredClone(state.truth.rng), resolutionPlans: [], resolutionReceipts: [], temporalPlans: [],
    temporalBoundary: { fromElapsedSeconds: source.truth.elapsedSeconds, toElapsedSeconds: record.atSeconds, deltaSeconds: record.atSeconds - source.truth.elapsedSeconds,
      reasons: [], dueActivityIds: record.completedActionIds, dueTimerIds: Object.keys(record.timerUpdates).filter(id => source.truth.timers[id]?.status !== record.timerUpdates[id]?.status), dueConditionIds: [] },
    temporalState: { activities: structuredClone(state.truth.activities), timers: structuredClone(state.truth.timers) }, activityTransitions: [], activityDispositions: [], sharedResourceAdmissions: [], decisionPoints: [],
    checkRequests: [], checks: [], randomRequests: [], randomResults: [], commitmentRounds: [], outcomes: record.outcomes, mechanicInvocations: [], mechanicResults: [],
    causalAssertionResults: [], causalVerification: { verdict: "accept", findings: [] }, events: record.events, observations: record.observations,
    operations: record.operations, decisionRequests: [], beliefPatches: record.beliefPatches, characterPatches: record.characterPatches, nextActions: [],
  };
  const semantic = { ...payload, semanticHash: contentHash(payload) };
  const committed: CommittedStep = { ...semantic, contentHash: contentHash(semantic) };
  state.history.push(committed); validateSimulationState(state, false);
  return { state, committed };
}
export function directCandidate(source: Readonly<SimulationState>, record: DirectStepRecord, step: CommittedStep, activatedAgentIds: string[]): WorldStepCandidate {
  const candidate: WorldStepCandidate = {
    directEvent: record, executionState: step.executionState, schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION, sourceStateHash: contentHash(source),
    onsetPerception: { targets: [], receipts: [], requests: [], checks: [], commitmentRounds: [], rng: source.truth.rng },
    resolution: { proposal: { baseRevision: source.revision, outcomes: step.outcomes, mechanicInvocations: [], operations: step.operations, events: step.events,
      observations: step.observations, decisionRequests: [] }, initialActions: step.initialActions, actions: step.actions, reactionRequests: [], reactionDecisions: [],
      stimulusObservations: [], requests: [], checks: [], randomRequests: [], randomResults: [], commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [],
      rng: step.rngAfter, mechanicResults: [], causalAssertionResults: [], causalVerification: step.causalVerification },
    finalCausalReview: { contentHash: "", evidenceHash: contentHash(record.decisions), promptVersion: "direct-world-v1", invocationIds: record.modelAudits.flatMap(audit => audit.invocations.map(invocation => invocation.id)) },
    mindCommits: [], modelAudits: record.modelAudits, interactionDependencies: [], diagnostics: { activatedAgentIds,
      reusedAgentIds: Object.keys(source.agents).filter(id => !activatedAgentIds.includes(id)), mindFallbackAgentIds: [], dependencyComponents: [], globalReadjudication: false },
    temporalPlans: [], temporalBoundary: step.temporalBoundary, temporalState: step.temporalState, activityTransitions: [], activityDispositions: [], sharedResourceAdmissions: [], decisionPoints: [],
  };
  candidate.finalCausalReview.contentHash = finalCausalReviewContentHash(candidate); return candidate;
}
export function replayDirectStep(source: Readonly<SimulationState>, step: CommittedStep): SimulationState {
  if (!step.directEvent) throw new Error("missing direct event");
  const result = commitDirectRecord(source, step.directEvent);
  const comparable = (value: CommittedStep) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "executionRef" && key !== "contentHash"));
  if (contentHash(comparable(result.committed)) !== contentHash(comparable(step))) throw new Error("direct replay differs from the committed receipt");
  result.state.history[result.state.history.length - 1] = structuredClone(step); return result.state;
}
