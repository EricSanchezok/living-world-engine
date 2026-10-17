import type { SimulationState } from "../contracts/model";
import type { ActionFrame, DirectRuntimeState } from "./contracts";

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

/** Unfinished participant work leaves room for actual local affairs and their delivered follow-through. */
export function localActivityActors(state: Readonly<SimulationState>, control: DirectRuntimeState, participantAgentIds: readonly string[]): Set<string> {
  const frames = state.history.flatMap(step => step.directEvent?.frames ?? []);
  const roots = control.activities.filter(frame => participantAgentIds.includes(frame.actorId));
  for (const id of participantAgentIds) {
    const intent = control.intents[id];
    if (!intent?.activeSubmission || !["ready", "active"].includes(intent.status) || roots.some(frame => frame.actorId === id)) continue;
    const prior = frames.findLast(frame => frame.actorId === id && frame.submissionId === intent.activeSubmission!.submissionId);
    if (prior) roots.push(prior);
  }
  if (!roots.length) return new Set();
  const submissions = new Set(roots.flatMap(frame => frame.submissionId ? [frame.submissionId] : []));
  const anchor = Math.min(...roots.map(frame => frame.startedAtSeconds), ...frames.filter(frame =>
    participantAgentIds.includes(frame.actorId) && frame.submissionId && submissions.has(frame.submissionId)).map(frame => frame.startedAtSeconds));
  const byId = new Map(frames.map(frame => [frame.id, frame]));
  const admitted = new Set(Object.keys(state.agents).filter(id => hasLocalOpportunity(state, id, roots)));
  const followers = new Map<string, string[]>();
  for (const [id, intent] of Object.entries(control.intents)) {
    if (!["ready", "active"].includes(intent.status) || !intent.causeActionId) continue;
    const cause = byId.get(intent.causeActionId);
    if (!cause || cause.dueAtSeconds === null || cause.dueAtSeconds < anchor || cause.dueAtSeconds > state.truth.elapsedSeconds) continue;
    const peers = followers.get(cause.actorId) ?? [];
    peers.push(id); followers.set(cause.actorId, peers);
  }
  const queue = [...admitted];
  for (let cursor = 0; cursor < queue.length; cursor++) for (const id of followers.get(queue[cursor]!) ?? []) {
    if (!admitted.has(id)) { admitted.add(id); queue.push(id); }
  }
  return admitted;
}
