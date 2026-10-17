import type {
  AgentActionProposal,
  AgentAdmissionCommit,
  AgentState,
  SimulationState,
  WorldEntity,
} from "../contracts/model";
import { pendingObservationsFor } from "../cognition/observation";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "./runtime-id";
import { applyAdmissionAdditions } from "./admission-additions";

export interface AdmissionCandidateState {
  entity: WorldEntity;
  placementId: string | null;
  agent: AgentState;
  meters: readonly import("../contracts/model").MeterState[];
  quantities: readonly import("../contracts/model").QuantityState[];
  ratings: readonly import("../contracts/model").RatingState[];
  conditions: readonly import("../mechanics/resolution").ConditionState[];
  additions: import("../contracts/model").AdmissionAdditions;
}

export interface AdmissionImpactResult {
  reusedActions: AgentActionProposal[];
  invalidatedAgentIds: string[];
  reasons: Record<string, string[]>;
}

function admissionPreview(
  source: Readonly<SimulationState>,
  candidate: Readonly<AdmissionCandidateState>,
): SimulationState {
  const preview = structuredClone(source) as SimulationState;
  preview.revision = source.revision + 1;
  preview.truth.entities[candidate.entity.id] = structuredClone(candidate.entity);
  preview.truth.placements[candidate.entity.id] = candidate.placementId;
  preview.agents[candidate.agent.id] = structuredClone(candidate.agent);
  for (const meter of candidate.meters) preview.truth.meters[meter.id] = structuredClone(meter);
  for (const quantity of candidate.quantities) preview.truth.quantities[quantity.id] = structuredClone(quantity);
  for (const rating of candidate.ratings) preview.truth.ratings[rating.id] = structuredClone(rating);
  for (const condition of candidate.conditions) preview.truth.conditions[condition.id] = structuredClone(condition);
  applyAdmissionAdditions(preview, candidate.additions, candidate.entity.id);
  return preview;
}

function perspectiveForReuse(state: Readonly<SimulationState>, agent: Readonly<AgentState>): unknown {
  const perspective = projectAgentPerspective(state, agent);
  // Revision changes for every admission, but it is engine metadata rather
  // than a change in the Agent's observable world. Historical turn revisions
  // remain part of the cognitive input and are intentionally preserved.
  return { ...perspective, revision: 0 };
}

function actionDraft(action: Readonly<AgentActionProposal>): unknown {
  return {
    actorId: action.actorId,
    rawText: action.rawText,
    goal: action.goal,
    means: action.means,
    targetIds: [...action.targetIds],
  };
}

function cognitiveInputHash(
  state: Readonly<SimulationState>,
  agent: Readonly<AgentState>,
): string {
  return contentHash({
    perspective: perspectiveForReuse(state, agent),
    observations: pendingObservationsFor(state, agent),
    belief: agent.belief,
    character: agent.character,
    bindings: agent.bindings,
    // Profile selection is part of the control strategy.  It is normally
    // stable across admission, but including it makes the proof fail closed
    // if a caller changes the Agent's model routing at the same boundary.
    modelProfiles: agent.modelProfiles,
    action: agent.nextAction ? actionDraft(agent.nextAction) : null,
  });
}

function actionTargetsRemainBound(
  state: Readonly<SimulationState>,
  agent: Readonly<AgentState>,
  action: Readonly<AgentActionProposal>,
): boolean {
  return action.targetIds.every((localId) => {
    const binding = agent.bindings[localId];
    return Boolean(agent.belief.localEntities[localId]) &&
      Boolean(binding && binding.canonicalEntityIds.length > 0) &&
      Boolean(binding?.canonicalEntityIds.every((canonicalId) => state.truth.entities[canonicalId]));
  });
}

function rebasePreparedAction(
  state: Readonly<SimulationState>,
  action: Readonly<AgentActionProposal>,
  revision: number,
): AgentActionProposal {
  return {
    ...structuredClone(action),
    id: runtimeId({
      worldHash: state.worldHash,
      revision,
      kind: "action",
      stage: "prepared",
      owner: action.actorId,
      round: 0,
      ordinal: 0,
    }),
    actorId: action.actorId,
    baseRevision: revision,
  };
}

export function computeAdmissionImpact(
  source: Readonly<SimulationState>,
  candidate: Readonly<AdmissionCandidateState>,
): AdmissionImpactResult {
  const preview = admissionPreview(source, candidate);
  const reusedActions: AgentActionProposal[] = [];
  const invalidatedAgentIds: string[] = [];
  const reasons: Record<string, string[]> = {};

  for (const agentId of Object.keys(source.agents).sort()) {
    const agent = source.agents[agentId]!;
    const action = agent.nextAction;
    const agentReasons: string[] = [];
    if (!action) agentReasons.push("missing_next_action");
    if (action && action.actorId !== agentId) agentReasons.push("action_actor_mismatch");
    if (action && action.baseRevision !== source.revision) agentReasons.push("action_revision_mismatch");
    if (action && !actionTargetsRemainBound(source, agent, action)) {
      agentReasons.push("invalid_local_target");
    }

    if (action && agentReasons.length === 0) {
      try {
        const beforeHash = cognitiveInputHash(source, agent);
        const previewAgent = preview.agents[agentId];
        if (!previewAgent || !actionTargetsRemainBound(preview, previewAgent, action)) {
          agentReasons.push("preview_binding_inconclusive");
        }
        const afterHash = previewAgent ? cognitiveInputHash(preview, previewAgent) : "";
        if (beforeHash !== afterHash) agentReasons.push("cognitive_input_changed");
      } catch {
        agentReasons.push("cognitive_input_inconclusive");
      }
    }

    if (agentReasons.length > 0 || !action) {
      invalidatedAgentIds.push(agentId);
      reasons[agentId] = agentReasons.length > 0 ? agentReasons : ["missing_next_action"];
      continue;
    }
    reusedActions.push(rebasePreparedAction(source, action, preview.revision));
    reasons[agentId] = ["cognitive_input_unchanged"];
  }

  return {
    reusedActions: reusedActions.sort((left, right) => left.actorId.localeCompare(right.actorId)),
    invalidatedAgentIds,
    reasons,
  };
}

export function actionDraftEqual(
  left: Readonly<AgentActionProposal>,
  right: Readonly<AgentActionProposal>,
): boolean {
  return contentHash(actionDraft(left)) === contentHash(actionDraft(right));
}

export function expectedRebasedActionId(
  state: Readonly<SimulationState>,
  agentId: string,
  revision: number,
): string {
  return runtimeId({
    worldHash: state.worldHash,
    revision,
    kind: "action",
    stage: "prepared",
    owner: agentId,
    round: 0,
    ordinal: 0,
  });
}

export function admissionCandidateFromCommit(
  commit: Readonly<AgentAdmissionCommit>,
): AdmissionCandidateState {
  return {
    entity: commit.entity,
    placementId: commit.placementId,
    agent: commit.agent,
    meters: commit.meters,
    quantities: commit.quantities,
    ratings: commit.ratings,
    conditions: commit.conditions,
    additions: commit.additions,
  };
}
