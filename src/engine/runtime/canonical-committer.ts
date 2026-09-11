import type {
  InteractionDependency,
  BootstrapCandidate,
  ExecutionRef,
  PolicyBinding,
  WorldStepCandidate,
} from "./execution";
import {
  ActivityFootprintIndex,
  buildInteractionDependencyGraph,
  interactionDependencyComponents,
  interactionDependencyForCondition,
  interactionDependencyForTimer,
} from "../mechanics/action-dependency";
import {
  resolutionObservations,
  finalCausalReviewContentHash,
  WORLD_STEP_CANDIDATE_SCHEMA_VERSION,
} from "./execution";
import { validatePublicInformationBoundary } from "../cognition/information-boundary";
import { createHistoryReplayBase } from "./history-replay";
import { applyMindCommit } from "../cognition/mind-commit";
import type {
  AgentAdmissionCommit,
  AgentActionProposal,
  AgentState,
  CommittedStep,
  ObservationPacket,
  MeterState,
  QuantityState,
  RatingState,
  SimulationState,
  TransitionProposal,
  WorldEntity,
} from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "./runtime-id";
import {
  applyObservationBindings,
  pendingObservationsFor,
  validateObservations,
} from "../cognition/observation";
import {
  advanceTemporalState,
  blockScheduledActivity,
  cancelActivity,
  cancelDeferredActivity,
  createActivity,
  evaluateActivityContinuation,
  materializeDeferredTemporalPlan,
  reconcileTemporalOutcomes,
  selectTemporalBoundary,
  settleActivityContexts,
  startReadyActivity,
  pauseActivity,
  validateActivityResources,
  validateTemporalPlan,
} from "../mechanics/temporal";
import { applyAdmissionCommit, applyTransitionProposal, validateSimulationState } from "./transaction";
import { computeAdmissionImpact } from "./admission-impact";
import { validateSharedActivityResourceClaimForAction } from "../mechanics/shared-activity-resources";
import {
  applySharedResourceAdmissions,
  materializeSharedResourceAdmissionOutcomes,
  planSharedResourceAdmissions,
  promoteSharedResourceQueues,
  validateSharedResourceCapacity,
} from "../mechanics/shared-resource-allocation";

export function semanticStepHash(step: Readonly<CommittedStep>): string {
  const semantic = structuredClone(step) as Partial<CommittedStep>;
  delete semantic.contentHash;
  delete semantic.semanticHash;
  delete semantic.executionRef;
  return contentHash(semantic);
}

export function attachExecutionRef(
  state: Readonly<SimulationState>,
  reference: Readonly<ExecutionRef>,
  phase: "bootstrap" | "step" | "admission",
): SimulationState {
  const finalized = structuredClone(state) as SimulationState;
  if (phase === "bootstrap") {
    if (finalized.history.length !== 0) throw new Error("bootstrap execution reference cannot attach after a step");
    finalized.bootstrapExecutionRef = structuredClone(reference);
  } else if (phase === "step") {
    const committed = finalized.history.at(-1);
    if (!committed) throw new Error("step execution reference requires a committed step");
    committed.executionRef = structuredClone(reference);
    const payload = { ...committed } as Partial<CommittedStep>;
    delete payload.contentHash;
    committed.contentHash = contentHash(payload);
  } else {
    const admission = finalized.admissions.at(-1);
    if (!admission) throw new Error("admission execution reference requires an admission commit");
    admission.executionRef = structuredClone(reference);
    const payload = { ...admission } as Partial<AgentAdmissionCommit>;
    delete payload.contentHash;
    admission.contentHash = contentHash(payload);
  }
  validateSimulationState(finalized, false, true);
  return finalized;
}

function observationsFor(packets: readonly ObservationPacket[], observerId: string): ObservationPacket[] {
  return packets.filter((packet) => packet.observerId === observerId);
}

function validateUniqueAgentIds(
  ids: readonly string[],
  label: string,
  knownAgentIds: ReadonlySet<string>,
): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate Agent ids`);
  for (const agentId of ids) {
    if (!knownAgentIds.has(agentId)) throw new Error(`${label} references unknown Agent ${agentId}`);
  }
}

function validateInteractionDependencies(
  source: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  dependencies: readonly InteractionDependency[],
  activities: Readonly<Record<string, import("../mechanics/temporal").ActivityState>>,
): void {
  const actionById = new Map(actions.map((action) => [action.id, action]));
  if (actionById.size !== actions.length) throw new Error("execution candidate contains duplicate action ids");
  if (new Set(dependencies.map((dependency) => `${dependency.kind}:${dependency.id}`)).size !== dependencies.length) {
    throw new Error("execution candidate contains duplicate interaction dependencies");
  }
  const expectedIds = [...actionById.keys()].sort();
  const actualIds = dependencies.filter((dependency) => dependency.kind === "action")
    .map((dependency) => dependency.id).sort();
  if (contentHash(expectedIds) !== contentHash(actualIds)) {
    throw new Error(
      `execution candidate interaction dependencies must cover every final action exactly once; expected=${expectedIds.join(",")}; actual=${actualIds.join(",")}`,
    );
  }
  const catalogs: Record<Exclude<InteractionDependency["reads"][number]["kind"], "global">, Readonly<Record<string, unknown>>> = {
    entity: source.truth.entities,
    fact: source.truth.facts,
    placement: source.truth.entities,
    meter: source.truth.meters,
    quantity: source.truth.quantities,
    rating: source.truth.ratings,
    condition: source.truth.conditions,
    activity: source.truth.activities,
    shared_resource_pool: source.truth.sharedActivityResourcePools,
  };
  for (const dependency of dependencies) {
    const expectedActorId = dependency.kind === "action"
      ? actionById.get(dependency.id)?.actorId
      : dependency.kind === "activity"
        ? activities[dependency.id]?.actorId
        : null;
    if (expectedActorId === undefined || dependency.actorId !== expectedActorId) {
      throw new Error(`interaction dependency actor mismatch for ${dependency.kind}:${dependency.id}`);
    }
    if ((dependency.kind === "timer" && !source.truth.timers[dependency.id]) ||
      (dependency.kind === "condition" && !source.truth.conditions[dependency.id])) {
      throw new Error(`interaction dependency references unknown ${dependency.kind} ${dependency.id}`);
    }
    for (const [label, refs] of [["reads", dependency.reads], ["writes", dependency.writes]] as const) {
      const keys = refs.map((ref) => `${ref.kind}:${ref.id}`);
      if (new Set(keys).size !== keys.length) {
        throw new Error(`interaction dependency ${dependency.id} contains duplicate ${label}`);
      }
      for (const ref of refs) {
        if (ref.kind !== "global" && !catalogs[ref.kind][ref.id]) {
          throw new Error(`interaction dependency ${dependency.id} references unknown ${ref.kind} ${ref.id}`);
        }
      }
    }
    if (new Set(dependency.audienceAgentIds).size !== dependency.audienceAgentIds.length) {
      throw new Error(`interaction dependency ${dependency.id} contains duplicate audiences`);
    }
    const claimPoolIds = new Set<string>();
    for (const claim of dependency.sharedResourceClaims) {
      if (claimPoolIds.has(claim.poolId)) {
        throw new Error(`interaction dependency ${dependency.id} contains duplicate shared resource claims`);
      }
      claimPoolIds.add(claim.poolId);
      const action = dependency.kind === "action" ? actionById.get(dependency.id) : activities[dependency.id]?.sourceAction;
      if (!action) throw new Error(`interaction dependency ${dependency.id} has no claim source action`);
      validateSharedActivityResourceClaimForAction(
        claim,
        action.rawText,
        source.truth.sharedActivityResourcePools,
        source.truth.mechanics.sharedActivityResources,
      );
    }
    for (const agentId of dependency.audienceAgentIds) {
      if (!source.agents[agentId]) {
        throw new Error(`interaction dependency ${dependency.id} references unknown audience Agent ${agentId}`);
      }
    }
    if (dependency.actorId !== null && !dependency.audienceAgentIds.includes(dependency.actorId)) {
      throw new Error(`interaction dependency ${dependency.id} must include its actor in the audience`);
    }
    const hasGlobal = [...dependency.reads, ...dependency.writes].some((ref) => ref.kind === "global");
    if (dependency.globalFallback !== hasGlobal) {
      throw new Error(`interaction dependency ${dependency.id} has inconsistent global fallback evidence`);
    }
  }
}

function validateStepDiagnostics(
  source: Readonly<SimulationState>,
  transitioned: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  candidate: Readonly<WorldStepCandidate>,
  policyRoster: Readonly<Record<string, PolicyBinding>>,
): void {
  const diagnostics = candidate.diagnostics;
  const knownAgentIds = new Set(Object.keys(transitioned.agents));
  validateUniqueAgentIds(diagnostics.activatedAgentIds, "activated Agent diagnostics", knownAgentIds);
  validateUniqueAgentIds(diagnostics.reusedAgentIds, "reused Agent diagnostics", knownAgentIds);
  validateUniqueAgentIds(diagnostics.mindFallbackAgentIds, "mind fallback diagnostics", knownAgentIds);
  if (diagnostics.activatedAgentIds.some((agentId) => diagnostics.reusedAgentIds.includes(agentId))) {
    throw new Error("activated and reused Agent diagnostics must be disjoint");
  }
  if (diagnostics.mindFallbackAgentIds.some((agentId) => !diagnostics.activatedAgentIds.includes(agentId))) {
    throw new Error("mind fallback diagnostics must reference activated Agents");
  }
  const updatedIds = [...diagnostics.activatedAgentIds, ...diagnostics.reusedAgentIds].sort();
  const committedIds = candidate.mindCommits.map((commit) => commit.agentId).sort();
  if (contentHash(updatedIds) !== contentHash(committedIds)) {
    throw new Error("algorithm diagnostics do not match AgentMind commits");
  }
  for (const agentId of diagnostics.activatedAgentIds) {
    if (source.agents[agentId] && policyRoster[agentId]?.kind !== "model") {
      throw new Error(`algorithm activated non-model Agent ${agentId}`);
    }
  }
  if (typeof diagnostics.globalReadjudication !== "boolean") {
    throw new Error("global readjudication diagnostic must be boolean");
  }
  const componentInteractionIds = diagnostics.dependencyComponents.flatMap((component) => {
    if (component.length === 0) throw new Error("dependency diagnostics contain an empty component");
    return component;
  });
  const expectedInteractionIds = candidate.interactionDependencies.map((dependency) => dependency.id).sort();
  if (new Set(componentInteractionIds).size !== componentInteractionIds.length ||
    contentHash([...componentInteractionIds].sort()) !== contentHash(expectedInteractionIds)) {
    throw new Error("dependency diagnostics must partition final interactions");
  }
  if (contentHash(diagnostics.dependencyComponents) !==
    contentHash(interactionDependencyComponents(candidate.interactionDependencies))) {
    throw new Error("dependency diagnostics do not match the final interaction dependency graph");
  }
  if (diagnostics.dependencyGraph) {
    const graph = buildInteractionDependencyGraph(candidate.interactionDependencies, "canonical");
    const summary = diagnostics.dependencyGraph;
    if (summary.mode !== "canonical" ||
      summary.nodeCount !== graph.nodeIds.length ||
      summary.edgeCount !== graph.edgeCount ||
      summary.componentCount !== graph.components.length ||
      summary.maxComponentSize !== graph.maxComponentSize ||
      contentHash(summary.globalFallbackNodeIds) !== contentHash(graph.globalFallbackNodeIds) ||
      summary.contentHash !== graph.contentHash) {
      throw new Error("dependency graph diagnostics do not match the canonical graph");
    }
  }
  if (diagnostics.globalReadjudication && actions.length > 0 && diagnostics.dependencyComponents.length !== 1) {
    throw new Error("global readjudication diagnostics require one dependency component");
  }
}

function isWithinSelf(state: Readonly<SimulationState>, entityId: string, selfEntityId: string): boolean {
  let current = entityId;
  const seen = new Set<string>([entityId]);
  while (true) {
    const placementId = state.truth.placements[current];
    if (!placementId || seen.has(placementId)) return false;
    if (placementId === selfEntityId) return true;
    seen.add(placementId);
    current = placementId;
  }
}

export function validateSelfConsequenceIntroductions(
  source: Readonly<SimulationState>,
  transitioned: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  proposal: Readonly<TransitionProposal>,
  observations: readonly ObservationPacket[],
): void {
  const outcomes = new Map(proposal.outcomes.map((outcome) => [outcome.proposalId, outcome]));
  for (const action of actions) {
    const outcome = outcomes.get(action.id);
    if (!outcome || outcome.status !== "succeeded" && outcome.status !== "partial") continue;
    const agent = source.agents[action.actorId];
    if (!agent) continue;
    const knownCanonicalIds = new Set(Object.values(agent.bindings)
      .flatMap((binding) => binding.canonicalEntityIds));
    const introducedCanonicalIds = new Set(observations
      .filter((observation) => observation.observerId === agent.id)
      .flatMap((observation) => observation.introductions)
      .flatMap((introduction) => introduction.canonicalEntityId ? [introduction.canonicalEntityId] : []));
    const required = new Set<string>();
    for (const operation of proposal.operations) {
      if (!operation.causes.some((cause) => cause.kind === "action" && cause.id === action.id)) continue;
      if (operation.kind === "create_entity" || operation.kind === "place_entity") {
        const entityId = operation.kind === "create_entity" ? operation.entity.id : operation.entityId;
        if (isWithinSelf(transitioned, entityId, agent.entityId)) required.add(entityId);
      }
      if (operation.kind === "set_fact" &&
        (operation.fact.access.kind === "public" ||
          operation.fact.access.kind === "agents" && operation.fact.access.agentIds.includes(agent.id))) {
        if (operation.fact.subjectId === agent.entityId && operation.fact.value.kind === "entity") {
          required.add(operation.fact.value.entityId);
        }
        if (operation.fact.value.kind === "entity" && operation.fact.value.entityId === agent.entityId) {
          required.add(operation.fact.subjectId);
        }
      }
    }
    for (const entityId of required) {
      if (entityId === agent.entityId || knownCanonicalIds.has(entityId) || introducedCanonicalIds.has(entityId)) continue;
      throw new Error(
        `successful self consequence for ${agent.id} references ${entityId} without an observer-local introduction`,
      );
    }
  }
}

function validateCandidateReactions(
  source: Readonly<SimulationState>,
  candidate: Readonly<WorldStepCandidate>,
  policyRoster: Readonly<Record<string, PolicyBinding>>,
): void {
  const requests = candidate.resolution.reactionRequests;
  const decisions = candidate.resolution.reactionDecisions;
  if (requests.length !== decisions.length ||
    new Set(requests.map((request) => request.id)).size !== requests.length ||
    new Set(requests.map((request) => request.agentId)).size !== requests.length ||
    new Set(decisions.map((decision) => decision.requestId)).size !== decisions.length) {
    throw new Error("reaction decisions must cover one frozen request per Agent");
  }
  const initialActionById = new Map(candidate.resolution.initialActions.map((action) => [action.id, action]));
  const decisionByRequest = new Map(decisions.map((decision) => [decision.requestId, decision]));
  const checkRequestById = new Map(candidate.resolution.requests.map((request) => [request.id, request]));
  const checkResultById = new Map(candidate.resolution.checks.map((result) => [result.requestId, result]));

  for (const request of requests) {
    const observer = source.agents[request.agentId];
    const trigger = initialActionById.get(request.triggerActionId);
    const triggerAgent = trigger && source.agents[trigger.actorId];
    if (!observer || !trigger || !triggerAgent || trigger.actorId === request.agentId ||
      request.stimulus.observerId !== request.agentId || request.stimulus.kind !== "stimulus" ||
      request.stimulus.step !== source.step + 1 || request.stimulus.sourceEventIds.length !== 0) {
      throw new Error(`reaction request ${request.id} has invalid onset identity or stimulus`);
    }
    let originalProposalId: string;
    if (request.originalIntent.kind === "prepared_action") {
      const original = initialActionById.get(request.originalIntent.actionId);
      if (!original || original.actorId !== request.agentId) {
        throw new Error(`reaction request ${request.id} has no matching prepared action`);
      }
      originalProposalId = original.id;
    } else {
      const activity = source.truth.activities[request.originalIntent.activityId];
      if (!activity || activity.status !== "active" || !activity.plan.interruptible ||
        activity.actorId !== request.agentId || activity.sourceActionId !== request.originalIntent.sourceActionId) {
        throw new Error(`reaction request ${request.id} has no matching interruptible Activity`);
      }
      originalProposalId = activity.sourceActionId;
    }

    const basisIds = new Set<string>();
    for (const basis of request.basis) {
      const key = basis.kind === "shared_placement"
        ? `${basis.kind}:${basis.placementId}`
        : basis.kind === "fact"
          ? `${basis.kind}:${basis.factId}`
          : `${basis.kind}:${basis.checkId}`;
      if (basisIds.has(key)) throw new Error(`reaction request ${request.id} repeats basis ${key}`);
      basisIds.add(key);
      if (basis.kind === "shared_placement") {
        const triggerPlacement = source.truth.placements[triggerAgent.entityId];
        const observerPlacement = source.truth.placements[observer.entityId];
        if (!triggerPlacement || triggerPlacement !== observerPlacement || triggerPlacement !== basis.placementId) {
          throw new Error(`reaction request ${request.id} has no shared placement basis`);
        }
      } else if (basis.kind === "fact") {
        const fact = source.truth.facts[basis.factId];
        const accessible = fact && (fact.access.kind === "public" ||
          fact.access.kind === "agents" && fact.access.agentIds.includes(request.agentId));
        const endpoints = fact?.value.kind === "entity"
          ? new Set([fact.subjectId, fact.value.entityId])
          : new Set<string>();
        if (!accessible || !endpoints.has(triggerAgent.entityId) || !endpoints.has(observer.entityId)) {
          throw new Error(`reaction request ${request.id} has no accessible relational Fact basis`);
        }
      } else {
        const checkRequest = checkRequestById.get(basis.checkId);
        const result = checkResultById.get(basis.checkId);
        if (!checkRequest || checkRequest.phase !== "perception" ||
          checkRequest.actorId !== observer.entityId || !result?.succeeded ||
          !checkRequest.causes.some((cause) => cause.kind === "action" && cause.id === trigger.id) ||
          !checkRequest.causes.some((cause) => cause.kind === "fact" || cause.kind === "law")) {
          throw new Error(`reaction request ${request.id} has no successful perception basis`);
        }
      }
    }

    const decision = decisionByRequest.get(request.id);
    const binding = policyRoster[request.agentId];
    if (!decision || decision.agentId !== request.agentId || decision.baseRevision !== source.revision ||
      decision.originalProposalId !== originalProposalId ||
      decision.source === "model" && binding?.kind !== "model" ||
      decision.source === "external" && binding?.kind !== "external" ||
      decision.source === "replay" && binding?.kind !== "replay") {
      throw new Error(`reaction decision for ${request.id} has invalid identity or policy provenance`);
    }
    if (decision.kind === "keep") {
      if (request.originalIntent.kind === "prepared_action" && decision.ongoingActivityDisposition !== "continue") {
        throw new Error(`prepared action reaction ${request.id} cannot pause or cancel an uncommitted Activity`);
      }
      if (decision.source === "profile_fallback" && request.originalIntent.kind === "ongoing_activity") {
        const activity = source.truth.activities[request.originalIntent.activityId]!;
        if (activity.status !== "active") throw new Error(`reaction fallback ${request.id} lost its active Activity`);
        const profile = source.truth.mechanics.temporalProfiles[activity.plan.profileId]!;
        const expected = profile.reactionFallback === "pause"
          ? "pause"
          : profile.reactionFallback === "cancel" ? "cancel" : "continue";
        if (decision.ongoingActivityDisposition !== expected) {
          throw new Error(`reaction fallback for ${request.id} contradicts its Temporal Profile`);
        }
      }
    } else if (!candidate.resolution.actions.some((action) =>
      action.id === decision.replacementAction.id && action.actorId === request.agentId)) {
      throw new Error(`reaction replacement for ${request.id} is absent from final actions`);
    }
  }
}

function validateCandidateBoundary(
  source: SimulationState,
  actions: readonly AgentActionProposal[],
  candidate: WorldStepCandidate,
  transitioned: SimulationState,
  maxAutonomousSpanSeconds: number,
  observations: readonly ObservationPacket[],
  policyRoster: Readonly<Record<string, PolicyBinding>>,
): void {
  if (candidate.schemaVersion !== WORLD_STEP_CANDIDATE_SCHEMA_VERSION) {
    throw new Error(`world step candidate schema v${WORLD_STEP_CANDIDATE_SCHEMA_VERSION} required`);
  }
  if (candidate.sourceStateHash !== contentHash(source)) throw new Error("execution candidate uses another source state");
  validateCandidateReactions(source, candidate, policyRoster);
  const outcomeIds = candidate.resolution.proposal.outcomes.map(outcome => outcome.id);
  if (new Set(outcomeIds).size !== outcomeIds.length) throw new Error("candidate contains duplicate outcome identities");
  if (new Set(actions.map((action) => action.actorId)).size !== actions.length) {
    throw new Error("execution candidate contains multiple actions for one Agent");
  }
  validateInteractionDependencies(source, actions, candidate.interactionDependencies, candidate.temporalState.activities);
  const trustedCapacityOperations = new Map<string, number>();
  for (const operation of candidate.resolution.mechanicResults.flatMap((result) => result.operations)) {
    if (operation.kind !== "set_shared_activity_resource_capacity") continue;
    const hash = contentHash(operation);
    trustedCapacityOperations.set(hash, (trustedCapacityOperations.get(hash) ?? 0) + 1);
  }
  for (const operation of candidate.resolution.proposal.operations) {
    if (operation.kind !== "set_shared_activity_resource_capacity") continue;
    const hash = contentHash(operation);
    const remaining = trustedCapacityOperations.get(hash) ?? 0;
    if (remaining <= 0) throw new Error("shared activity resource capacity must come from a trusted mechanic result");
    trustedCapacityOperations.set(hash, remaining - 1);
  }
  const advances = candidate.resolution.proposal.operations.filter((operation) => operation.kind === "advance_time");
  if (advances.length !== 1) throw new Error("every world step must contain exactly one time advance");
  // A transition may introduce Agents and immediately give them an outcome
  // observation. Validate the public boundary against the transitioned state
  // so those new observers are legitimate while hidden cognition remains
  // protected by the same token audit.
  validatePublicInformationBoundary(transitioned, actions, candidate.resolution.proposal);
  validateObservations(transitioned, observations, transitioned.step);
  validateSelfConsequenceIntroductions(
    source,
    transitioned,
    actions,
    candidate.resolution.proposal,
    observations,
  );
  const outcomeObservers = new Set(candidate.resolution.proposal.observations
    .filter((packet) => packet.kind === "outcome")
    .map((packet) => packet.observerId));
  for (const agentId of new Set(actions.map((action) => action.actorId))) {
    if (!outcomeObservers.has(agentId)) throw new Error(`transition must provide an outcome observation for agent ${agentId}`);
  }
  const advance = advances[0]!;
  if (advance.seconds !== candidate.temporalBoundary.deltaSeconds ||
    candidate.temporalBoundary.fromElapsedSeconds !== source.truth.elapsedSeconds ||
    candidate.temporalBoundary.toElapsedSeconds !== transitioned.truth.elapsedSeconds) {
    throw new Error("candidate time advance does not match its temporal boundary");
  }
  if (contentHash(candidate.temporalState.activities) !== contentHash(transitioned.truth.activities) ||
    contentHash(candidate.temporalState.timers) !== contentHash(transitioned.truth.timers)) {
    throw new Error("candidate temporal state was not applied atomically");
  }
  const planIds = candidate.temporalPlans.map((plan) => plan.id);
  if (new Set(planIds).size !== planIds.length) throw new Error("candidate contains duplicate temporal plans");
  const planningActivities = structuredClone(source.truth.activities);
  const preBoundaryTransitions = [] as typeof candidate.activityTransitions;
  const readyPlans: import("../mechanics/temporal").TemporalPlan[] = [];
  const readyDecisionPoints: import("../mechanics/temporal").DecisionPoint[] = [];
  const readyEvaluationState = structuredClone(source);
  for (const ready of Object.values(planningActivities)
    .filter((activity): activity is import("../mechanics/temporal").ReadyActivityState => activity.status === "ready")
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const started = startReadyActivity({
      activity: ready,
      atSeconds: source.truth.elapsedSeconds,
      profiles: source.truth.mechanics.temporalProfiles,
    });
    planningActivities[ready.id] = started.activity;
    readyEvaluationState.truth.activities[ready.id] = structuredClone(started.activity);
    readyPlans.push(structuredClone(started.activity.plan));
    preBoundaryTransitions.push(started.transition);
    if (evaluateActivityContinuation(readyEvaluationState, started.activity).some((result) => !result.passed)) {
      const blocked = blockScheduledActivity(started.activity, source.truth.elapsedSeconds);
      planningActivities[ready.id] = blocked.activity;
      readyEvaluationState.truth.activities[ready.id] = structuredClone(blocked.activity);
      preBoundaryTransitions.push(blocked.transition);
      readyDecisionPoints.push(blocked.decisionPoint);
    }
  }
  const actualReadyTransitions = candidate.activityTransitions.filter((transition) =>
    transition.fromElapsedSeconds === source.truth.elapsedSeconds &&
    transition.toElapsedSeconds === source.truth.elapsedSeconds && Boolean(source.truth.activities[transition.activityId]?.status === "ready") &&
    (transition.kind === "started" || transition.kind === "blocked"));
  if (contentHash(actualReadyTransitions) !== contentHash(preBoundaryTransitions)) {
    throw new Error("candidate ready Activity starts do not match trusted reservations");
  }
  for (const transition of candidate.activityTransitions) {
    if (transition.fromElapsedSeconds !== source.truth.elapsedSeconds ||
      transition.toElapsedSeconds !== source.truth.elapsedSeconds) continue;
    if (transition.kind === "queued" || transition.kind === "blocked" || transition.kind === "started") continue;
    if (transition.kind !== "cancelled" && transition.kind !== "paused") {
      throw new Error(`candidate has unsupported zero-time activity transition ${transition.kind}`);
    }
    const existing = planningActivities[transition.activityId];
    if (!existing || existing.actorId !== transition.actorId) {
      throw new Error(`candidate cancels unknown activity ${transition.activityId}`);
    }
    if (transition.kind === "cancelled" && (existing.status === "queued" || existing.status === "ready")) {
      const expected = cancelDeferredActivity(existing, source.truth.elapsedSeconds);
      if (contentHash(expected) !== contentHash(transition)) {
        throw new Error(`candidate pre-boundary transition does not match deferred Activity ${transition.activityId}`);
      }
      delete planningActivities[transition.activityId];
      preBoundaryTransitions.push(structuredClone(expected));
      continue;
    }
    if (existing.status === "queued" || existing.status === "ready") {
      throw new Error(`candidate cannot pause deferred Activity ${transition.activityId}`);
    }
    const settled = transition.kind === "cancelled"
      ? cancelActivity(existing, source.truth.elapsedSeconds)
      : pauseActivity(existing, source.truth.elapsedSeconds);
    if (contentHash(settled.transition) !== contentHash(transition)) {
      throw new Error(`candidate pre-boundary transition does not match activity ${transition.activityId}`);
    }
    planningActivities[transition.activityId] = settled.activity;
    preBoundaryTransitions.push(structuredClone(settled.transition));
  }
  for (const plan of candidate.temporalPlans) {
    validateTemporalPlan(
      plan,
      source.truth.mechanics.temporalProfiles,
      source.truth.mechanics.activityResources,
    );
    if (plan.startsAtSeconds !== source.truth.elapsedSeconds) {
      throw new Error(`candidate temporal plan ${plan.id} does not start at the current clock`);
    }
    const persisted = Object.values(candidate.temporalState.activities)
      .filter((activity): activity is import("../mechanics/temporal").ScheduledActivityState =>
        activity.status !== "queued" && activity.status !== "ready" && activity.plan.id === plan.id);
    if (persisted.length !== 1 || contentHash(persisted[0]!.plan) !== contentHash(plan)) {
      throw new Error(`candidate temporal plan ${plan.id} has no unique matching activity`);
    }
    const finalActivity = persisted[0]!;
    if (planningActivities[finalActivity.id]) {
      const readyPlan = readyPlans.find((candidatePlan) => candidatePlan.id === plan.id);
      if (!readyPlan || contentHash(readyPlan) !== contentHash(plan)) {
        throw new Error(`candidate temporal plan reuses activity ${finalActivity.id}`);
      }
      continue;
    }
    planningActivities[finalActivity.id] = createActivity({
      id: finalActivity.id,
      plan,
      sourceAction: finalActivity.sourceAction,
      participantAgentIds: finalActivity.participantAgentIds,
      interactionFootprint: finalActivity.interactionFootprint,
    });
  }
  for (const admission of candidate.sharedResourceAdmissions) {
    if (planningActivities[admission.activityId]) continue;
    const persisted = candidate.temporalState.activities[admission.activityId];
    if (!persisted || (persisted.status !== "queued" && persisted.status !== "ready")) {
      throw new Error(`resource admission references unknown deferred Activity ${admission.activityId}`);
    }
    const plan = materializeDeferredTemporalPlan({
      draft: persisted.planDraft,
      sourceAction: persisted.sourceAction,
      startsAtSeconds: source.truth.elapsedSeconds,
      profiles: source.truth.mechanics.temporalProfiles,
    });
    validateTemporalPlan(plan, source.truth.mechanics.temporalProfiles, source.truth.mechanics.activityResources);
    planningActivities[persisted.id] = createActivity({
      id: persisted.id,
      plan,
      sourceAction: persisted.sourceAction,
      participantAgentIds: persisted.participantAgentIds,
      interactionFootprint: persisted.interactionFootprint,
    });
  }
  const proposedActivityIds = Object.values(planningActivities)
    .filter((activity) => !source.truth.activities[activity.id])
    .map((activity) => activity.id)
    .sort();
  const expectedAdmissions = planSharedResourceAdmissions({
    activities: planningActivities,
    proposalActivityIds: proposedActivityIds,
    pools: source.truth.sharedActivityResourcePools,
    definitions: source.truth.mechanics.sharedActivityResources,
    entities: source.truth.entities,
  }).admissions;
  if (contentHash(expectedAdmissions) !== contentHash(candidate.sharedResourceAdmissions)) {
    throw new Error("candidate shared resource admissions do not match trusted capacity allocation");
  }
  const expectedAdjudicationActionIds = [...new Set(expectedAdmissions.flatMap((admission) =>
    admission.kind === "adjudicate" ? admission.competingActivityIds.map((activityId) => {
      const activity = planningActivities[activityId];
      if (!activity) throw new Error(`adjudication references unknown holder Activity ${activityId}`);
      return activity.sourceActionId;
    }) : []))].sort();
  const actualActionIds = new Set(actions.map((action) => action.id));
  if (expectedAdjudicationActionIds.some((actionId) => !actualActionIds.has(actionId))) {
    throw new Error("shared resource adjudication omitted a competing holder action");
  }
  const appliedAdmissions = applySharedResourceAdmissions({
    activities: planningActivities,
    admissions: expectedAdmissions,
    atSeconds: source.truth.elapsedSeconds,
  });
  const actualAdmissionTransitions = candidate.activityTransitions.filter((transition) =>
    transition.fromElapsedSeconds === source.truth.elapsedSeconds &&
    transition.toElapsedSeconds === source.truth.elapsedSeconds &&
    (transition.kind === "queued" || transition.kind === "blocked"));
  if (contentHash(actualAdmissionTransitions) !== contentHash(appliedAdmissions.transitions)) {
    throw new Error("candidate shared resource admission transitions do not match trusted allocation");
  }
  const deferredActionIds = new Set(appliedAdmissions.deferredActionIds);
  const expectedResourceOutcomes = materializeSharedResourceAdmissionOutcomes({
    worldHash: source.worldHash,
    revision: source.revision,
    actions,
    admissions: expectedAdmissions,
    activities: appliedAdmissions.activities,
    pools: source.truth.sharedActivityResourcePools,
    definitions: source.truth.mechanics.sharedActivityResources,
  });
  const actualResourceOutcomes = candidate.resolution.proposal.outcomes
    .filter((outcome) => deferredActionIds.has(outcome.proposalId))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
  if (contentHash(expectedResourceOutcomes) !== contentHash(actualResourceOutcomes) ||
    candidate.resolution.resolutionPlans.some((plan) => deferredActionIds.has(plan.actionId)) ||
    candidate.resolution.proposal.operations.some((operation) => operation.causes.some((cause) =>
      cause.kind === "action" && deferredActionIds.has(cause.id)) && operation.kind !== "advance_time") ||
    candidate.resolution.proposal.events.some((event) => event.causes.some((cause) =>
      cause.kind === "action" && deferredActionIds.has(cause.id)))) {
    throw new Error("deferred shared resource actions cannot be semantically adjudicated");
  }
  Object.assign(planningActivities, appliedAdmissions.activities);
  preBoundaryTransitions.push(...structuredClone(appliedAdmissions.transitions));
  for (const transition of preBoundaryTransitions.filter((entry) => entry.kind === "cancelled")) {
    const authorizedReaction = candidate.resolution.reactionRequests.some((request) =>
      request.originalIntent.kind === "ongoing_activity" &&
      request.originalIntent.activityId === transition.activityId) &&
      candidate.resolution.reactionDecisions.some((decision) =>
        decision.requestId === candidate.resolution.reactionRequests.find((request) =>
          request.originalIntent.kind === "ongoing_activity" &&
          request.originalIntent.activityId === transition.activityId)?.id &&
        (decision.kind === "replace" || decision.ongoingActivityDisposition === "cancel"));
    if (!candidate.temporalPlans.some((plan) => plan.actorId === transition.actorId) && !authorizedReaction) {
      throw new Error(`candidate cancels activity ${transition.activityId} without a replacement plan`);
    }
  }
  validateActivityResources(planningActivities, source.truth.mechanics.activityResources);
  const conditionExpiries = Object.fromEntries(Object.values(source.truth.conditions)
    .filter((condition) => condition.expiresAtElapsedSeconds !== null)
    .map((condition) => [condition.id, condition.expiresAtElapsedSeconds!]));
  const expectedBoundary = selectTemporalBoundary({
    elapsedSeconds: source.truth.elapsedSeconds,
    maxAutonomousSpanSeconds,
    activities: planningActivities,
    timers: source.truth.timers,
    conditionExpiries,
  });
  if (contentHash(expectedBoundary) !== contentHash(candidate.temporalBoundary)) {
    throw new Error("candidate did not select the earliest trusted temporal boundary");
  }
  const expectedTimerDependencies = expectedBoundary.dueTimerIds.map((timerId) =>
    interactionDependencyForTimer(source, source.truth.timers[timerId]!));
  const actualTimerDependencies = candidate.interactionDependencies
    .filter((dependency) => dependency.kind === "timer");
  if (contentHash(actualTimerDependencies) !== contentHash(expectedTimerDependencies)) {
    throw new Error("candidate Timer interaction dependencies do not match the trusted boundary");
  }
  const expectedConditionDependencies = expectedBoundary.dueConditionIds.map((conditionId) =>
    interactionDependencyForCondition(source, source.truth.conditions[conditionId]!));
  const actualConditionDependencies = candidate.interactionDependencies
    .filter((dependency) => dependency.kind === "condition");
  if (contentHash(actualConditionDependencies) !== contentHash(expectedConditionDependencies)) {
    throw new Error("candidate Condition interaction dependencies do not match the trusted boundary");
  }
  const dueActivityActors = new Set(expectedBoundary.dueActivityIds.map((activityId) => {
    const activity = planningActivities[activityId];
    if (!activity) throw new Error(`trusted boundary references unknown activity ${activityId}`);
    return activity.actorId;
  }));
  const timerDescriptionsByAgent = new Map<string, string[]>();
  for (const timerId of expectedBoundary.dueTimerIds) {
    const timer = source.truth.timers[timerId];
    if (!timer) throw new Error(`trusted boundary references unknown Timer ${timerId}`);
    for (const agentId of timer.wakeAgentIds) {
      const descriptions = timerDescriptionsByAgent.get(agentId) ?? [];
      descriptions.push(timer.description);
      timerDescriptionsByAgent.set(agentId, descriptions);
    }
  }
  [...timerDescriptionsByAgent.entries()]
    .filter(([agentId]) => !dueActivityActors.has(agentId))
    .forEach(([agentId, descriptions], ordinal) => {
      const expectedAction = {
        id: runtimeId({
          worldHash: source.worldHash,
          revision: source.revision,
          kind: "action",
          stage: "timer",
          owner: agentId,
          round: 0,
          ordinal,
        }),
        actorId: agentId,
        baseRevision: source.revision,
        rawText: `处理同时到期的世界定时触发：${descriptions.join("；")}`,
        goal: "根据当前世界事实联合结算已到期触发",
        means: null,
        targetIds: [],
      };
      const actual = actions.find((action) => action.actorId === agentId);
      if (!actual || contentHash(actual) !== contentHash(expectedAction)) {
        throw new Error(`candidate does not adjudicate due Timer for ${agentId}`);
      }
    });
  let expectedTemporal = advanceTemporalState({
    boundary: expectedBoundary,
    activities: planningActivities,
    timers: source.truth.timers,
  });
  expectedTemporal.transitions = [...preBoundaryTransitions, ...expectedTemporal.transitions];
  const reactionDecisionPoints = preBoundaryTransitions.flatMap((transition) => {
    const request = candidate.resolution.reactionRequests.find((entry) =>
      entry.originalIntent.kind === "ongoing_activity" &&
      entry.originalIntent.activityId === transition.activityId);
    const decision = request && candidate.resolution.reactionDecisions.find((entry) =>
      entry.requestId === request.id);
    return decision?.kind === "keep" && decision.ongoingActivityDisposition !== "continue"
      ? [{
          agentId: transition.actorId,
          reason: "activity_interrupted" as const,
          activityId: transition.activityId,
          timerId: null,
        }]
      : [];
  });
  expectedTemporal.decisionPoints = [...new Map([
    ...expectedTemporal.decisionPoints,
    ...reactionDecisionPoints,
    ...readyDecisionPoints,
    ...appliedAdmissions.decisionPoints,
  ].map((point) => [
    `${point.agentId}:${point.reason}:${point.activityId ?? ""}:${point.timerId ?? ""}`,
    point,
  ])).values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
  expectedTemporal = reconcileTemporalOutcomes(expectedTemporal, candidate.resolution.proposal.outcomes);

  const actionDependencies = candidate.interactionDependencies
    .filter((dependency) => dependency.kind === "action");
  const currentActionIds = new Set(actions.map((action) => action.id));
  const expectedAffectedActivityIds = new ActivityFootprintIndex(planningActivities)
    .affectedBy([
      ...actionDependencies,
      ...expectedTimerDependencies,
      ...expectedConditionDependencies,
    ])
    .filter((activityId) => !currentActionIds.has(planningActivities[activityId]!.sourceActionId));
  const actualActivityDependencies = candidate.interactionDependencies
    .filter((dependency) => dependency.kind === "activity")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (contentHash(actualActivityDependencies.map((dependency) => dependency.id)) !==
    contentHash(expectedAffectedActivityIds)) {
    throw new Error("candidate Activity interaction dependencies do not match the trusted footprint index");
  }
  for (const dependency of actualActivityDependencies) {
    const expected = planningActivities[dependency.id]?.interactionFootprint;
    if (!expected || contentHash(dependency) !== contentHash(expected)) {
      throw new Error(`candidate changes the persisted footprint of Activity ${dependency.id}`);
    }
  }

  const observedAgentIds = new Set(observations.map((observation) => observation.observerId));
  // A validated retained footprint is context, not a newly emitted boundary interaction.
  const relevantExternalObservers = new Set(candidate.interactionDependencies.filter((dependency) => dependency.kind !== "activity").flatMap((dependency) =>
    dependency.audienceAgentIds.filter((agentId) =>
      agentId !== dependency.actorId && observedAgentIds.has(agentId))));
  const contextActivityIds = [...new Set([
    ...expectedAffectedActivityIds,
    ...expectedBoundary.dueActivityIds,
    ...candidate.resolution.reactionRequests.flatMap((request) =>
      request.originalIntent.kind === "ongoing_activity" ? [request.originalIntent.activityId] : []),
  ])].sort();
  const preContextState = applyTransitionProposal(source, candidate.resolution.proposal, {
    activities: expectedTemporal.activities,
    timers: expectedTemporal.timers,
  });
  const preTransitionState = structuredClone(source);
  preTransitionState.truth.activities = structuredClone(planningActivities);
  const preserveActiveActivityIds = new Set(candidate.resolution.reactionDecisions.flatMap((decision) => {
    if (decision.kind !== "keep" || decision.ongoingActivityDisposition !== "continue") return [];
    const request = candidate.resolution.reactionRequests.find((entry) => entry.id === decision.requestId);
    if (!request) return [];
    if (request.originalIntent.kind === "ongoing_activity") return [request.originalIntent.activityId];
    const preparedActionId = request.originalIntent.actionId;
    const activity = Object.values(expectedTemporal.activities).find((entry) =>
      entry.sourceActionId === preparedActionId);
    return activity ? [activity.id] : [];
  }));
  const settled = settleActivityContexts({
    preTransitionState,
    state: preContextState,
    temporal: expectedTemporal,
    activityIds: contextActivityIds,
    relevantObserverIds: relevantExternalObservers,
    preserveActiveActivityIds,
  });
  expectedTemporal = settled.temporal;
  const promotionState = applyTransitionProposal(source, candidate.resolution.proposal, expectedTemporal);
  const expectedPromotion = promoteSharedResourceQueues({
    activities: expectedTemporal.activities,
    pools: promotionState.truth.sharedActivityResourcePools,
    definitions: promotionState.truth.mechanics.sharedActivityResources,
    entities: promotionState.truth.entities,
    atSeconds: expectedBoundary.toElapsedSeconds,
  });
  expectedTemporal.activities = expectedPromotion.activities;
  expectedTemporal.transitions = [...expectedTemporal.transitions, ...expectedPromotion.transitions];
  validateSharedResourceCapacity({
    activities: expectedTemporal.activities,
    pools: promotionState.truth.sharedActivityResourcePools,
    definitions: promotionState.truth.mechanics.sharedActivityResources,
    entities: promotionState.truth.entities,
  });
  if (contentHash(expectedTemporal.activities) !== contentHash(candidate.temporalState.activities) ||
    contentHash(expectedTemporal.timers) !== contentHash(candidate.temporalState.timers) ||
    contentHash(expectedTemporal.transitions) !== contentHash(candidate.activityTransitions) ||
    contentHash(expectedTemporal.decisionPoints) !== contentHash(candidate.decisionPoints) ||
    contentHash(settled.dispositions) !== contentHash(candidate.activityDispositions)) {
    throw new Error("candidate temporal transitions do not match the trusted boundary result");
  }
  for (const point of expectedTemporal.decisionPoints) {
    const occupying = Object.values(expectedTemporal.activities).find((activity) =>
      activity.status === "active" && activity.participantAgentIds.includes(point.agentId));
    if (occupying) {
      throw new Error(`decision point for ${point.agentId} conflicts with active Activity ${occupying.id}`);
    }
  }
}

export class CanonicalCommitter {
  admit(sourceState: Readonly<SimulationState>, candidate: Readonly<{
    entity: WorldEntity;
    placementId: string | null;
    agent: AgentState;
    meters: readonly MeterState[];
    quantities: readonly QuantityState[];
    ratings: readonly RatingState[];
    conditions: readonly import("../mechanics/resolution").ConditionState[];
  }>): { committed: AgentAdmissionCommit; state: SimulationState } {
    const source = structuredClone(sourceState) as SimulationState;
    const semantic = {
      baseRevision: source.revision,
      revision: source.revision + 1,
      step: source.step,
      entity: structuredClone(candidate.entity),
      placementId: candidate.placementId,
      agent: structuredClone(candidate.agent),
      meters: candidate.meters.map((entry) => structuredClone(entry)),
      quantities: candidate.quantities.map((entry) => structuredClone(entry)),
      ratings: candidate.ratings.map((entry) => structuredClone(entry)),
      conditions: candidate.conditions.map((entry) => structuredClone(entry)),
      invalidatedActionIds: Object.values(source.agents)
        .flatMap((agent) => agent.nextAction ? [agent.nextAction.id] : [])
        .sort(),
      reusedActions: computeAdmissionImpact(source, candidate).reusedActions,
    };
    const committed: AgentAdmissionCommit = {
      contentHash: "",
      semanticHash: contentHash(semantic),
      ...semantic,
    };
    const payload = { ...committed } as Partial<AgentAdmissionCommit>;
    delete payload.contentHash;
    committed.contentHash = contentHash(payload);
    applyAdmissionCommit(source, committed);
    validateSimulationState(source, false, true);
    return { committed: structuredClone(committed), state: source };
  }

  bootstrap(sourceState: Readonly<SimulationState>, candidate: Readonly<BootstrapCandidate>): SimulationState {
    const source = structuredClone(sourceState) as SimulationState;
    if (candidate.schemaVersion !== WORLD_STEP_CANDIDATE_SCHEMA_VERSION) {
      throw new Error(`bootstrap candidate schema v${WORLD_STEP_CANDIDATE_SCHEMA_VERSION} required`);
    }
    if (candidate.sourceStateHash !== contentHash(source)) throw new Error("bootstrap candidate uses another source state");
    const commits = candidate.agentCommits.map((commit) => structuredClone(commit))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const expectedAgents = Object.keys(source.agents).sort((left, right) => left.localeCompare(right));
    const committedAgents = commits.map((commit) => commit.agentId);
    if (contentHash(expectedAgents) !== contentHash(committedAgents)) {
      throw new Error("bootstrap candidate does not update every agent exactly once");
    }
    const knownAgentIds = new Set(expectedAgents);
    validateUniqueAgentIds(candidate.diagnostics.activatedAgentIds, "bootstrap activation diagnostics", knownAgentIds);
    validateUniqueAgentIds(candidate.diagnostics.reusedAgentIds, "bootstrap reuse diagnostics", knownAgentIds);
    validateUniqueAgentIds(candidate.diagnostics.mindFallbackAgentIds, "bootstrap fallback diagnostics", knownAgentIds);
    if (candidate.diagnostics.reusedAgentIds.length > 0 ||
      contentHash([...candidate.diagnostics.activatedAgentIds].sort()) !== contentHash(committedAgents) ||
      candidate.diagnostics.mindFallbackAgentIds.some((agentId) =>
        !candidate.diagnostics.activatedAgentIds.includes(agentId))) {
      throw new Error("bootstrap diagnostics do not match AgentMind commits");
    }
    source.bootstrapAgentCommits = commits.map((commit) => ({
      agentId: commit.agentId,
      beliefPatch: structuredClone(commit.beliefPatch),
      characterPatch: structuredClone(commit.characterPatch),
      nextAction: structuredClone(commit.nextAction),
    }));
    for (const commit of source.bootstrapAgentCommits) {
      source.agents[commit.agentId] = applyMindCommit(
        source.agents[commit.agentId],
        commit,
        source.step,
        [],
        [],
      );
    }
    validateSimulationState(source, true, true);
    return source;
  }

  step(
    sourceState: Readonly<SimulationState>,
    candidateInput: Readonly<WorldStepCandidate>,
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    maxAutonomousSpanSeconds: number,
  ): {
    committed: CommittedStep;
    state: SimulationState;
  } {
    const source = structuredClone(sourceState) as SimulationState;
    const candidate = structuredClone(candidateInput);
    const mindCommits = candidate.mindCommits
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
    const resolution = candidate.resolution;
    const observations = resolutionObservations(resolution);
    const transitioned = applyTransitionProposal(source, resolution.proposal, candidate.temporalState);
    validateCandidateBoundary(
      source,
      resolution.actions,
      candidate,
      transitioned,
      maxAutonomousSpanSeconds,
      observations,
      policyRoster,
    );
    validateStepDiagnostics(
      source,
      transitioned,
      resolution.actions,
      candidate,
      policyRoster,
    );
    if (resolution.causalVerification.verdict !== "accept" ||
      !candidate.finalCausalReview || candidate.finalCausalReview.contentHash !== finalCausalReviewContentHash(candidate) ||
      candidate.finalCausalReview.invocationIds.length === 0 ||
      !candidate.finalCausalReview.invocationIds.every(id => candidate.modelAudits.some(audit =>
        audit.role === "causal-verifier" && audit.promptVersion === candidate.finalCausalReview.promptVersion &&
        audit.invocations.some(invocation => invocation.id === id)))) {
      throw new Error("final causal review does not cover the committed candidate");
    }
    transitioned.truth.rng = structuredClone(resolution.rng);
    for (const agentId of Object.keys(transitioned.agents)) {
      transitioned.agents[agentId] = applyObservationBindings(
        transitioned.agents[agentId],
        observationsFor(observations, agentId),
      );
    }
    const committedAgents = mindCommits.map((commit) => commit.agentId);
    if (new Set(committedAgents).size !== committedAgents.length) {
      throw new Error("step candidate contains duplicate AgentMind commits");
    }
    for (const agentId of committedAgents) {
      if (!transitioned.agents[agentId] || source.agents[agentId] && policyRoster[agentId]?.kind !== "model") {
        throw new Error(`step candidate cannot update AgentMind for ${agentId}`);
      }
    }
    for (const commit of mindCommits) {
      const observed = pendingObservationsFor(
        transitioned,
        transitioned.agents[commit.agentId],
        observationsFor(observations, commit.agentId),
      );
      transitioned.agents[commit.agentId] = applyMindCommit(
        transitioned.agents[commit.agentId],
        commit,
        transitioned.step,
        observed,
        resolution.proposal.events,
      );
    }
    transitioned.historyBase ??= createHistoryReplayBase(source);
    validateSimulationState(transitioned, false);
    const semanticPayload: Omit<CommittedStep, "contentHash" | "semanticHash"> = {
      baseRevision: source.revision,
      revision: transitioned.revision,
      step: transitioned.step,
      initialActions: structuredClone(resolution.initialActions),
      reactionRequests: structuredClone(resolution.reactionRequests),
      reactionDecisions: structuredClone(resolution.reactionDecisions),
      actions: structuredClone(resolution.actions),
      rngBefore: structuredClone(source.truth.rng),
      rngAfter: structuredClone(transitioned.truth.rng),
      resolutionPlans: structuredClone(resolution.resolutionPlans),
      resolutionReceipts: structuredClone(resolution.resolutionReceipts),
      temporalPlans: structuredClone(candidate.temporalPlans),
      temporalBoundary: structuredClone(candidate.temporalBoundary),
      temporalState: structuredClone(candidate.temporalState),
      activityTransitions: structuredClone(candidate.activityTransitions),
      activityDispositions: structuredClone(candidate.activityDispositions),
      sharedResourceAdmissions: structuredClone(candidate.sharedResourceAdmissions),
      decisionPoints: structuredClone(candidate.decisionPoints),
      checkRequests: structuredClone(resolution.requests),
      checks: structuredClone(resolution.checks),
      randomRequests: structuredClone(resolution.randomRequests),
      randomResults: structuredClone(resolution.randomResults),
      commitmentRounds: structuredClone(resolution.commitmentRounds),
      outcomes: structuredClone(resolution.proposal.outcomes),
      mechanicInvocations: structuredClone(resolution.proposal.mechanicInvocations),
      mechanicResults: structuredClone(resolution.mechanicResults),
      causalAssertionResults: structuredClone(resolution.causalAssertionResults),
      causalVerification: structuredClone(resolution.causalVerification),
      events: structuredClone(resolution.proposal.events),
      observations: structuredClone(observations),
      operations: structuredClone(resolution.proposal.operations),
      decisionRequests: structuredClone(resolution.proposal.decisionRequests),
      beliefPatches: mindCommits.map((commit) => structuredClone(commit.beliefPatch)),
      characterPatches: mindCommits.map((commit) => structuredClone(commit.characterPatch)),
      nextActions: mindCommits.map((commit) => structuredClone(commit.nextAction)),
    };
    const committedPayload: Omit<CommittedStep, "contentHash"> = {
      semanticHash: contentHash(semanticPayload),
      ...semanticPayload,
    };
    const committed: CommittedStep = { contentHash: contentHash(committedPayload), ...committedPayload };
    transitioned.history.push(committed);
    validateSimulationState(transitioned, false, true);
    return { committed: structuredClone(committed), state: transitioned };
  }
}
