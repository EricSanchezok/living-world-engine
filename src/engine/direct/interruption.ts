import type { ObservationPacket, SimulationState, WorldEvent } from "../contracts/model";
import { runtimeId } from "../runtime/runtime-id";
import type { ActionFrame, DirectRuntimeState } from "./contracts";
import type { ActionSettlement } from "./world";
import { sharesContactNeighborhood } from "./views";

/** Activity identities are immutable; a newly admitted listener invalidates a cached match. */
export function interruptionCandidates(state: Readonly<SimulationState>, control: DirectRuntimeState, frame: ActionFrame) {
  return control.activities.filter(activity => activity.id !== frame.id && activity.actorId !== frame.actorId &&
    activity.activityStatus === "active" && activity.interruptCondition &&
    (!activity.temporalProfileId || state.truth.mechanics.temporalProfiles[activity.temporalProfileId]?.interruptible) &&
    sharesContactNeighborhood(state, activity.actorEntityId, frame.actorEntityId));
}

/** A prepared semantic match takes effect only at its actual delivered event. */
export function interruptActivities(state: Readonly<SimulationState>, control: DirectRuntimeState,
  candidates: Readonly<Record<string, readonly string[]>>,
  settlements: readonly ActionSettlement[], events: readonly WorldEvent[], observations: readonly ObservationPacket[], atSeconds: number, step: number) {
  const interrupted: ActionSettlement[] = [], interruptionEvents: WorldEvent[] = [];
  for (const [index, settlement] of settlements.entries()) {
    const triggeringEvent = events[index]!;
    for (const activityId of candidates[settlement.frame.id] ?? []) {
      const activity = control.activities.find(activity => activity.id === activityId);
      if (!activity || activity.activityStatus !== "active" || !activity.interruptCondition || activity.startedAtSeconds > atSeconds ||
        activity.dueAtSeconds !== null && activity.dueAtSeconds <= atSeconds ||
        !observations.some(observation => observation.observerId === activity.actorId && observation.sourceEventIds.includes(triggeringEvent.id))) continue;
      const elapsed = atSeconds - activity.startedAtSeconds;
      const frame = { ...structuredClone(activity), durationSeconds: elapsed, progressSeconds: elapsed, dueAtSeconds: atSeconds,
        utterance: null, interruptedByEventIds: [triggeringEvent.id],
        ...(activity.expression ? { expression: { ...activity.expression, utterance: null, manner: null } } : {}) };
      const ordinal = settlements.length + interrupted.length;
      const source = { causes: [{ kind: "action" as const, id: frame.id }, { kind: "event" as const, id: triggeringEvent.id }],
        assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: atSeconds }] };
      const summary = `这项活动已进行${elapsed}秒；你按照预先说明的条件停下，剩余活动未执行。`;
      const outcome = { id: runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "outcome", stage: "direct-world", owner: frame.actorId, round: 0, ordinal }),
        proposalId: frame.id, status: "partial" as const, summary, causeRefs: source.causes, assertions: source.assertions, knownAlternatives: [] };
      interrupted.push({ frame, outcome, visibleManner: null, operations: [], visibleFacts: [], inspectedQuantities: [], visibleEntities: [],
        actorOnlyFactIds: [], actorOnlyEntityIds: [], namedEntityIds: [], deliveredToEntityIds: [], actorVisibleToEntityIds: [] });
      interruptionEvents.push({ id: runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "event", stage: "direct-world", owner: frame.actorId, round: 0, ordinal }),
        step, description: summary, impact: "ordinary", ...source });
      control.activities = control.activities.filter(current => current.id !== frame.id);
      delete control.prepared[frame.id];
      const intent = control.intents[frame.actorId]!;
      intent.status = "waiting"; intent.activityId = null; intent.activeSubmission = null; intent.causeActionId = null;
      intent.wakeReasons = []; intent.recentOutcomeIds = [outcome.id];
      intent.wait = { entityIds: [], untilSeconds: null, reason: "conditional-interruption" };
      if (frame.submissionId && !control.completedSubmissionIds.includes(frame.submissionId)) control.completedSubmissionIds.push(frame.submissionId);
    }
  }
  return { settlements: interrupted, events: interruptionEvents };
}
