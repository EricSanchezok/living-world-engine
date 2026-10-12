import type { ActionOutcome, AgentActionProposal, CommittedStep, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { createHistoryReplayBase } from "../runtime/history-replay";
import type { JsonObject } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { BootstrapCandidate, WorldStepCandidate } from "../runtime/execution";
import { WORLD_STEP_CANDIDATE_SCHEMA_VERSION, finalCausalReviewContentHash } from "../runtime/execution";
import { validateSimulationState } from "../runtime/transaction";
import { worldProgramTiming, worldProvenance } from "./adjudication";
import type { DecisionEventBootstrap, DecisionEventStep } from "./execution-contract";
import { initialDecisionEventState, readDecisionEventState, type DecisionEventState } from "./runtime-state";
import { validateControlTransition } from "./control-validation";
import { settleProgramWorldEvent } from "./settlement";
import { applyProgramGoalEvidence } from "./goal-completion";

const equal = (a: unknown, b: unknown) => contentHash(a) === contentHash(b);
function validateAuthority(state: Readonly<SimulationState>, authority: WorldRuntimeContract) {
  if (authority.contentHash !== state.worldHash || authority.id !== state.worldId ||
    !equal(authority.laws.map(law => law.id), state.lawIds) ||
    authority.historyBaseHash !== contentHash(createHistoryReplayBase(state as SimulationState))) throw new Error("event authority differs from the pinned world");
  if (state.bootstrapDecisionEvent && !equal(state.bootstrapDecisionEvent.authority, authority)) throw new Error("event authority changed after bootstrap");
}

export function applyDecisionEventBootstrap(source: Readonly<SimulationState>, proof: DecisionEventBootstrap): SimulationState {
  if (source.revision !== 0 || source.history.length || source.bootstrapDecisionEvent || proof.version !== 1) throw new Error("native bootstrap requires a new instance");
  validateAuthority(source, proof.authority);
  const initial = initialDecisionEventState(source, proof.control.models, proof.control.modelCatalogHash, proof.control.registryHash);
  const roster = Object.fromEntries(Object.values(source.agents).map(agent => [agent.id, {
    kind: "model" as const, agentId: agent.id, profiles: agent.modelProfiles,
  }]));
  validateControlTransition(source, initial, proof.control, proof.authority, proof.producerHash, proof.decisions, proof.modelAudits, roster);
  const state = structuredClone(source) as SimulationState;
  state.historyBase ??= createHistoryReplayBase(state);
  state.executionState = { producerHash: proof.producerHash, data: structuredClone(proof.control) as unknown as JsonObject };
  state.bootstrapDecisionEvent = structuredClone(proof);
  applyProgramGoalEvidence(state, proof.control, source.revision);
  for (const agent of Object.values(state.agents)) agent.nextAction = null;
  validateSimulationState(state, false);
  return state;
}

/** Derive both durable state and the existing read-side presentation from native evidence. */
export function deriveDecisionEventStep(source: Readonly<SimulationState>, proof: DecisionEventStep, producerHash: string, verifyControl = true) {
  validateAuthority(source, proof.authority);
  if (!source.executionState || source.executionState.producerHash !== producerHash || proof.version !== 1 ||
    proof.request.expectedRevision !== source.revision) throw new Error("event execution source changed");
  const before = readDecisionEventState(source.executionState, source);
  if (verifyControl) validateControlTransition(source, before, proof.preparedControl, proof.authority, producerHash,
    proof.decisions, proof.modelAudits, proof.policyRoster, proof.request.externalActions);
  let state: SimulationState, computed: DecisionEventState;
  let observations: CommittedStep["observations"] = [], beliefPatches: CommittedStep["beliefPatches"] = [], characterPatches: CommittedStep["characterPatches"] = [];
  if (proof.event) {
    const settled = settleProgramWorldEvent(source, proof.preparedControl, proof.event, proof.authority, producerHash, proof.beliefRevisions);
    state = settled.state; computed = settled.control; observations = settled.observations; beliefPatches = settled.beliefPatches; characterPatches = settled.characterPatches;
  } else {
    if (proof.beliefRevisions.length) throw new Error("a control revision cannot fabricate new observation evidence");
    state = structuredClone(source) as SimulationState; state.revision += 1;
    for (const agent of Object.values(state.agents)) agent.nextAction = null;
    computed = proof.preparedControl;
    const goals = applyProgramGoalEvidence(state, computed, source.revision);
    beliefPatches = goals.beliefPatches; characterPatches = goals.characterPatches;
  }
  const executionOnly = (value: DecisionEventState) => ({ ...value, hash: "", decisionCache: null, modelOrdinals: null });
  if (!equal(executionOnly(computed), executionOnly(proof.finalControl))) throw new Error("final program state differs from canonical settlement");
  state.executionState = { producerHash, data: structuredClone(proof.finalControl) as unknown as JsonObject };
  readDecisionEventState(state.executionState, state);
  const event = proof.event, programs = event?.programs ?? [];
  const actions: AgentActionProposal[] = programs.map(bound => {
    const agent = source.agents[bound.attempt.actorId]!;
    const targetIds = bound.attempt.targetEntityIds.map(id => Object.values(agent.bindings).find(binding =>
      binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === id)?.localEntityId)
      .filter((id): id is string => id !== undefined);
    return { id: bound.attempt.id, actorId: agent.id, baseRevision: source.revision, rawText: bound.attempt.intent,
      goal: bound.attempt.intent, means: bound.attempt.utterance, targetIds };
  });
  const outcomes: ActionOutcome[] = programs.map(bound => {
    const branch = bound.program.definition.branches.find(branch => branch.id === event!.selections.find(value => value.attemptId === bound.attempt.id)!.branchId)!;
    const observed = branch.acknowledgement === "observed-outcome";
    return { id: `outcome:${bound.attempt.id}`, proposalId: bound.attempt.id, status: observed ? branch.outcome : "succeeded",
      summary: observed ? event!.deliveries.filter(delivery => delivery.attemptId === bound.attempt.id &&
        delivery.recipientEntityId === bound.attempt.actorEntityId && delivery.kind === "observation").map(delivery => delivery.text).join("\n")
        : `Attempt executed: ${bound.attempt.intent}`, causeRefs: worldProvenance(bound).causes,
      assertions: worldProvenance(bound).assertions, knownAlternatives: [] };
  });
  const temporalBoundary: CommittedStep["temporalBoundary"] = { fromElapsedSeconds: source.truth.elapsedSeconds,
    toElapsedSeconds: state.truth.elapsedSeconds, deltaSeconds: state.truth.elapsedSeconds - source.truth.elapsedSeconds,
    reasons: [...(event?.clockBoundary.timers.map(timer => ({ kind: "timer" as const, timerId: timer.id })) ?? []),
      ...(event?.clockBoundary.conditions.map(conditionId => ({ kind: "condition_expiry" as const, conditionId })) ?? [])],
    dueActivityIds: [], dueTimerIds: event?.clockBoundary.timers.map(timer => timer.id) ?? [], dueConditionIds: event?.clockBoundary.conditions ?? [] };
  const payload: Omit<CommittedStep, "contentHash" | "semanticHash"> = {
    decisionEvent: structuredClone(proof), executionState: structuredClone(state.executionState),
    baseRevision: source.revision, revision: state.revision, step: state.step,
    initialActions: actions, actions, reactionRequests: [], reactionDecisions: [],
    rngBefore: structuredClone(source.truth.rng), rngAfter: structuredClone(state.truth.rng),
    resolutionPlans: [], resolutionReceipts: [], temporalPlans: programs.map(bound => worldProgramTiming(bound, proof.preparedControl.worldResources)),
    temporalBoundary, temporalState: { activities: structuredClone(state.truth.activities), timers: structuredClone(state.truth.timers) },
    activityTransitions: [], activityDispositions: [], sharedResourceAdmissions: [],
    decisionPoints: [...new Set(observations.map(packet => packet.observerId))].map(agentId => ({
      agentId, reason: "activity_completed", activityId: null, timerId: null })),
    checkRequests: [], checks: [], randomRequests: event?.randomness?.plan.requests ?? [], randomResults: event?.randomness?.results ?? [],
    commitmentRounds: [], outcomes, mechanicInvocations: event?.mechanicInvocations ?? [], mechanicResults: event?.mechanicResults ?? [], causalAssertionResults: [],
    causalVerification: { verdict: "accept", findings: [] }, events: state.truth.events.slice(source.truth.events.length),
    observations, operations: event?.effects ?? [], decisionRequests: [], beliefPatches, characterPatches, nextActions: [],
  };
  const semantic = { ...payload, semanticHash: contentHash(payload) };
  const committed: CommittedStep = { ...semantic, contentHash: contentHash(semantic) };
  state.historyBase ??= createHistoryReplayBase(source as SimulationState);
  state.history.push(committed); validateSimulationState(state, false);
  return { state, committed };
}

export function nativeCandidate(source: Readonly<SimulationState>, proof: DecisionEventStep, producerHash: string,
  activatedAgentIds: string[]): WorldStepCandidate {
  const { committed: step } = deriveDecisionEventStep(source, proof, producerHash, false);
  const candidate: WorldStepCandidate = {
    decisionEvent: proof, executionState: step.executionState, schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION,
    sourceStateHash: contentHash(source), onsetPerception: { targets: [], receipts: [], requests: [], checks: [], commitmentRounds: [], rng: structuredClone(source.truth.rng) },
    resolution: { proposal: { baseRevision: source.revision, outcomes: step.outcomes, mechanicInvocations: step.mechanicInvocations, operations: step.operations,
      events: step.events, observations: step.observations, decisionRequests: step.decisionRequests }, initialActions: step.initialActions, actions: step.actions,
      reactionRequests: [], reactionDecisions: [], stimulusObservations: [], requests: [], checks: [], randomRequests: step.randomRequests,
      randomResults: step.randomResults, commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [], rng: step.rngAfter,
      mechanicResults: step.mechanicResults, causalAssertionResults: [], causalVerification: step.causalVerification },
    finalCausalReview: { contentHash: "", evidenceHash: contentHash(proof.event?.adjudication ?? {}), promptVersion: "source-bound-decision-v1",
      invocationIds: proof.event?.adjudication.evidence.flatMap(evidence => evidence.result.audit.invocations.map(invocation => invocation.id)) ?? [] },
    mindCommits: [], modelAudits: proof.modelAudits, interactionDependencies: [],
    diagnostics: { activatedAgentIds, reusedAgentIds: Object.keys(source.agents).filter(id => !activatedAgentIds.includes(id)), mindFallbackAgentIds: [],
      dependencyComponents: step.actions.length ? [step.actions.map(action => action.id)] : [], globalReadjudication: false },
    temporalPlans: step.temporalPlans, temporalBoundary: step.temporalBoundary, temporalState: step.temporalState, activityTransitions: [],
    activityDispositions: [], sharedResourceAdmissions: [], decisionPoints: step.decisionPoints,
  };
  candidate.finalCausalReview.contentHash = finalCausalReviewContentHash(candidate);
  return candidate;
}

export function commitDecisionEventBootstrap(source: Readonly<SimulationState>, candidate: Readonly<BootstrapCandidate>) {
  if (!candidate.decisionEvent || candidate.schemaVersion !== WORLD_STEP_CANDIDATE_SCHEMA_VERSION ||
    candidate.sourceStateHash !== contentHash(source) || candidate.agentCommits.length || !equal(candidate.modelAudits, candidate.decisionEvent.modelAudits)) {
    throw new Error("invalid native bootstrap candidate");
  }
  return applyDecisionEventBootstrap(source, candidate.decisionEvent);
}

export function replayDecisionEventStep(source: Readonly<SimulationState>, step: CommittedStep) {
  if (!step.decisionEvent || !step.executionState) throw new Error("native replay proof missing");
  const result = deriveDecisionEventStep(source, step.decisionEvent, step.executionState.producerHash);
  const withoutEnvelope = (value: CommittedStep) => {
    const copy = { ...value }; delete copy.executionRef; return { ...copy, contentHash: "" };
  };
  if (!equal(withoutEnvelope(step), withoutEnvelope(result.committed))) throw new Error("native step presentation or state differs from replayed evidence");
  result.state.history[result.state.history.length - 1] = structuredClone(step);
  return result.state;
}
