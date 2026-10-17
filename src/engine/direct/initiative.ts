import type { SimulationState } from "../contracts/model";
import type { ActionFrame } from "./contracts";

/** Select opportunities in canonical space; the chosen Agent still receives only its own perspective. */
export function hasLocalOpportunity(state: Readonly<SimulationState>, agentId: string, playerActions: readonly ActionFrame[]): boolean {
  const agent = state.agents[agentId];
  if (!agent) return false;
  const place = state.truth.placements[agent.entityId];
  const anchors = new Set(playerActions.flatMap(frame => [frame.actorEntityId, frame.targetEntityId,
    state.truth.placements[frame.actorEntityId]])
    .filter((id): id is string => Boolean(id)));
  if (anchors.has(agent.entityId)) return true;
  if (place && [...anchors].some(id => id === place || state.truth.placements[place] === id || state.truth.placements[id] === place)) return true;
  const subjects = [...Object.values(agent.character.goals).filter(goal => goal.status === "active").flatMap(goal => goal.targetIds),
    ...Object.values(agent.character.commitments).filter(commitment => commitment.status === "active").flatMap(commitment => commitment.subjectIds)];
  return subjects.some(id => agent.bindings[id]?.canonicalEntityIds.some(canonicalId => anchors.has(canonicalId)));
}
