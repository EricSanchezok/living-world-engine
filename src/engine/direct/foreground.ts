import type { SimulationState } from "../contracts/model";
import type { DirectRuntimeState } from "./contracts";

function participantCauses(state: Readonly<SimulationState>, control: DirectRuntimeState,
  participantAgentIds: string[], submissionIds?: string[]): Set<string> {
  return new Set([...state.history.flatMap(step => step.directEvent?.frames ?? []), ...control.activities]
    .filter(frame => frame.submissionId && participantAgentIds.includes(frame.actorId) &&
      (!submissionIds || submissionIds.includes(frame.submissionId))).map(frame => frame.id));
}

/** Direct replies and their explicit follow-through hold the participant's turn. */
export function participantReactionIds(state: Readonly<SimulationState>, control: DirectRuntimeState,
  participantAgentIds: string[], submissionIds?: string[]): Set<string> {
  const causes = participantCauses(state, control, participantAgentIds, submissionIds);
  return new Set(Object.entries(control.intents).flatMap(([id, intent]) => {
    if (!["ready", "active"].includes(intent.status) || participantAgentIds.includes(id)) return [];
    return [intent.causeActionId, ...intent.pendingCauseActionIds].some(cause => cause && causes.has(cause)) ? [id] : [];
  }));
}

/** Selection prioritizes a delivered participant request without interrupting admitted work. */
export function prioritizeParticipantCauses(state: Readonly<SimulationState>, control: DirectRuntimeState, participantAgentIds: string[]) {
  const causes = participantCauses(state, control, participantAgentIds);
  for (const [id, intent] of Object.entries(control.intents)) {
    if (intent.status !== "ready" || participantAgentIds.includes(id) || intent.causeActionId && causes.has(intent.causeActionId)) continue;
    const index = intent.pendingCauseActionIds.findIndex(cause => causes.has(cause));
    if (index < 0) continue;
    const [cause] = intent.pendingCauseActionIds.splice(index, 1);
    if (intent.causeActionId) intent.pendingCauseActionIds.unshift(intent.causeActionId);
    intent.causeActionId = cause!;
  }
}
