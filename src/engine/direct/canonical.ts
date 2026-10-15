import { assertExactKeys } from "../runtime/json";
import { applyJsonDelta } from "../runtime/json-delta";
import type { CommittedStep, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { JsonObject } from "../runtime/json";
import { createHistoryReplayBase } from "../runtime/history-replay";
import { applyWorldDeltaOperation, validateSimulationState } from "../runtime/transaction";
import { applyObservationBindings, validateObservations } from "../cognition/observation";
import { applyBeliefPatch } from "../cognition/belief";
import { applyCharacterPatch } from "../cognition/character";
import type { DirectBootstrap, DirectStepRecord, DirectCommittedStep } from "./contracts";
import { readDependency, readDirectState } from "./state";
import { applyDirectCognition } from "./cognition";
import { resolveDiscreteRandomRequests } from "../mechanics/random";
import { evaluateCausalAssertion } from "../mechanics/causality";
import { nextWorldClockBoundary } from "./clock";

export function applyDirectBootstrap(source: Readonly<SimulationState>, bootstrap: DirectBootstrap): SimulationState {
  if (source.revision !== 0 || source.executionState || source.history.length || bootstrap.version !== 2) throw new Error("direct bootstrap requires an initial world");
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
  assertExactKeys(record, ["version", "id", "baseRevision", "producerHash", "authorityHash", "reads", "fromSeconds", "atSeconds", "frames",
    "completedActionIds", "controlDelta", "operations", "events", "outcomes", "observations", "beliefPatches", "characterPatches", "cognition",
    "decisions", "modelAudits", "rng", "randomRequests", "randomResults", "timerUpdates"], ["presentation"], "Direct event");
  if (record.version !== 2 || record.id !== contentHash({ ...record, id: "" }) || source.revision !== record.baseRevision ||
    source.executionState?.producerHash !== record.producerHash || source.bootstrapDirect?.authorityHash !== record.authorityHash) throw new Error("direct commit identity mismatch");
  if (source.history.some(step => step.directEvent?.id === record.id)) throw new Error("direct event already committed");
  for (const [key, expected] of Object.entries(record.reads)) if (contentHash(readDependency(source, key)) !== expected) throw new Error(`stale direct read ${key}`);
  if (record.fromSeconds !== source.truth.elapsedSeconds || !Number.isSafeInteger(record.atSeconds) || record.atSeconds < source.truth.elapsedSeconds ||
    record.frames.length && record.atSeconds <= source.truth.elapsedSeconds) throw new Error("physical event time must advance");
  if (record.frames.some(frame => frame.dueAtSeconds !== record.atSeconds || frame.startedAtSeconds > source.truth.elapsedSeconds ||
    source.agents[frame.actorId]?.entityId !== frame.actorEntityId)) throw new Error("invalid direct activity boundary or owner");
  const beforeControl = readDirectState(source.executionState, source);
  const control = directControlAfter(beforeControl, record);
  for (const reply of record.presentation ?? []) {
    const owner = source.agents[reply.agentId];
    if (!owner || !reply.requested.trim() || !control.completedSubmissionIds.includes(reply.submissionId) ||
      reply.focusLocalEntityId && !owner.belief.localEntities[reply.focusLocalEntityId] ||
      record.frames.some(frame => frame.actorId === reply.agentId)) throw new Error("invalid presentation-only reply");
  }
  if (beforeControl.activities.some(frame => frame.activityStatus === "active" && frame.dueAtSeconds !== null && frame.dueAtSeconds < record.atSeconds && !record.completedActionIds.includes(frame.id))) throw new Error("cannot pass an earlier admitted activity");
  for (const timer of Object.values(source.truth.timers)) if (timer.status === "scheduled" && timer.dueAtSeconds < record.atSeconds) throw new Error("cannot pass an earlier timer");
  const clock = nextWorldClockBoundary(source);
  if (clock !== null && clock < record.atSeconds) throw new Error("cannot pass an earlier condition boundary");
  for (const request of record.randomRequests) if (!Object.values(beforeControl.prepared).some(preparation =>
    preparation.randomRequests.some(committed => contentHash(committed) === contentHash(request)))) throw new Error("random stakes must be persisted before execution");
  const random = resolveDiscreteRandomRequests(source.truth.rng, record.randomRequests);
  if (contentHash(random.rng) !== contentHash(record.rng) || contentHash(random.results) !== contentHash(record.randomResults)) throw new Error("random receipt differs from the committed deterministic draw");
  const timers = structuredClone(source.truth.timers), timed = { ...source, truth: { ...source.truth, elapsedSeconds: record.atSeconds } } as SimulationState;
  for (const timer of Object.values(timers)) if (timer.status === "scheduled" && timer.dueAtSeconds === record.atSeconds) {
    timer.status = timer.assertions.every(assertion => evaluateCausalAssertion(timed, assertion).passed) ? "fired" : "cancelled";
  }
  if (contentHash(timers) !== contentHash(record.timerUpdates)) throw new Error("timer updates differ from the clock boundary");
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
  state.executionState = { producerHash: record.producerHash, data: structuredClone(control) as unknown as JsonObject };
  readDirectState(state.executionState, state);
  const { operations, events, outcomes, observations, beliefPatches, characterPatches, randomRequests, randomResults,
    rng, atSeconds, fromSeconds, ...directEvent } = structuredClone(record);
  const payload: Omit<DirectCommittedStep, "semanticHash" | "contentHash"> = {
    directEvent, baseRevision: source.revision, revision: state.revision, step: state.step,
    actions: directEvent.frames.map(frame => structuredClone(frame.proposal)), operations, events, outcomes, observations, beliefPatches, characterPatches,
    randomRequests, randomResults, rngBefore: structuredClone(source.truth.rng), rngAfter: rng,
    temporalBoundary: { fromElapsedSeconds: fromSeconds, toElapsedSeconds: atSeconds, deltaSeconds: atSeconds - fromSeconds,
      reasons: [], dueActivityIds: record.completedActionIds,
      dueTimerIds: Object.keys(record.timerUpdates).filter(id => source.truth.timers[id]?.status !== record.timerUpdates[id]?.status), dueConditionIds: [] },
  };
  const semantic = { ...payload, semanticHash: contentHash(payload) };
  const committed: DirectCommittedStep = { ...semantic, contentHash: contentHash(semantic) };
  state.history.push(committed); validateSimulationState(state, false);
  return { state, committed };
}
export function replayDirectStep(source: Readonly<SimulationState>, step: CommittedStep): SimulationState {
  if (!step.directEvent) throw new Error("missing direct event");
  const result = commitDirectRecord(source, directRecord(step));
  const comparable = (value: CommittedStep) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "executionRef" && key !== "contentHash"));
  if (contentHash(comparable(result.committed)) !== contentHash(comparable(step))) throw new Error("direct replay differs from the committed receipt");
  result.state.history[result.state.history.length - 1] = structuredClone(step); return result.state;
}

export function directControlAfter(before: import("./contracts").DirectRuntimeState, record: Pick<DirectStepRecord, "controlDelta">): import("./contracts").DirectRuntimeState {
  return applyJsonDelta(before as unknown as JsonObject, record.controlDelta) as unknown as import("./contracts").DirectRuntimeState;
}

/** Historical readers follow the same hash-bound control journal as replay. */
export function* directControlHistory(state: Readonly<SimulationState>): Generator<[number, import("./contracts").DirectRuntimeState]> {
  let control = state.bootstrapDirect?.control;
  if (!control) return;
  for (const step of state.history) {
    if (!step.directEvent) throw new Error("direct history contains another protocol");
    control = directControlAfter(control, step.directEvent);
    yield [step.revision, control];
  }
}

export function directRecord(step: DirectCommittedStep): DirectStepRecord {
  return { ...step.directEvent, operations: step.operations, events: step.events, outcomes: step.outcomes,
    observations: step.observations, beliefPatches: step.beliefPatches, characterPatches: step.characterPatches,
    randomRequests: step.randomRequests, randomResults: step.randomResults, rng: step.rngAfter,
    fromSeconds: step.temporalBoundary.fromElapsedSeconds, atSeconds: step.temporalBoundary.toElapsedSeconds };
}
