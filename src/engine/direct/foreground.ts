import type { SimulationState } from "../contracts/model";
import type { DirectRuntimeState } from "./contracts";

/** Direct replies and their explicit follow-through hold the participant's turn. */
export function participantReactionIds(state: Readonly<SimulationState>, control: DirectRuntimeState,
  participantAgentIds: string[], submissionIds?: string[]): Set<string> {
  const frames = new Map([...state.history.flatMap(step => step.directEvent?.frames ?? []), ...control.activities]
    .map(frame => [frame.id, frame]));
  return new Set(Object.entries(control.intents).flatMap(([id, intent]) => {
    if (!intent.causeActionId || !["ready", "active"].includes(intent.status) || participantAgentIds.includes(id)) return [];
    const cause = frames.get(intent.causeActionId);
    return cause?.submissionId && participantAgentIds.includes(cause.actorId) &&
      (!submissionIds || submissionIds.includes(cause.submissionId)) ? [id] : [];
  }));
}
