import type { ActivityState, TemporalBoundary, TemporalPlanBasis } from "../mechanics/temporal";
import { contentHash } from "../models/model-audit";
import type { CausalAssertion } from "./model";
import type { ReferenceResolver } from "./model-context";

export const ACTIVITY_TEMPORAL_EVIDENCE = "activity-temporal-evidence-v1";
export const ACTIVITY_TEMPORAL_NOTICE = "state.temporalExecution contains the engine's current interval and existing activity execution state. Join its boundary references to its activity records and the reference catalog. Adjudicate only effects supported during that interval while preserving each complete action's intent. A checkpoint is not completion; null completion time does not mean immediate completion; queued or ready work has not started. Respect progress, stages and continuation assertions. Partial effects may occur before a checkpoint when supported by the action and rules. Do not turn preparation or an unmet later objective into completed work, or substitute injury or another effect merely to make a check representable. Review candidate effects against this same interval and source evidence.";

/** Project trusted execution data without selecting outcomes or interpreting action prose. */
export function activityTemporalEvidence(input: {
  worldHash: string;
  revision: number;
  activities: readonly Readonly<ActivityState>[];
  boundary: Readonly<TemporalBoundary>;
  resolver: ReferenceResolver;
  projectAssertion: (assertion: CausalAssertion) => unknown;
}) {
  const ref = (kind: Parameters<ReferenceResolver["handleFor"]>[0], id: string) => input.resolver.handleFor(kind, id);
  const basis = (value: Readonly<TemporalPlanBasis>) => {
    const { profileId, ...rest } = value;
    if (rest.kind === "mechanic") {
      const { invocationId, ...details } = rest;
      return { ...structuredClone(details), profileRef: ref("temporal_profile", profileId), mechanicInvocationRef: ref("mechanic", invocationId) };
    }
    return { ...structuredClone(rest), profileRef: ref("temporal_profile", profileId) };
  };
  const activities = Object.fromEntries(input.activities.map(activity => {
    const plan = "plan" in activity ? activity.plan : activity.planDraft;
    return [ref("activity", activity.id), {
      sourceActionRef: ref("action", activity.sourceActionId), actorRef: ref("agent", activity.actorId),
      participantAgentRefs: activity.participantAgentIds.map(id => ref("agent", id)),
      status: activity.status, updatedAtSeconds: activity.updatedAtSeconds,
      resourceClaims: structuredClone(activity.resourceClaims),
      sharedResourceClaims: activity.sharedResourceClaims.map(claim => ({
        poolRef: ref("shared_resource_pool", claim.poolId), definitionId: claim.definitionId,
        entityRef: ref("entity", claim.entityId), amount: claim.amount,
        basis: claim.basis.kind === "mechanic"
          ? { kind: claim.basis.kind, mechanicInvocationRef: ref("mechanic", claim.basis.invocationId) }
          : structuredClone(claim.basis),
      })),
      plan: {
        sourcePlanHash: contentHash(plan), profileRef: ref("temporal_profile", plan.profileId), mode: plan.mode,
        description: plan.description, basis: basis(plan.basis), interruptible: plan.interruptible,
        resourceClaims: structuredClone(plan.resourceClaims),
        continuationAssertions: plan.continuationAssertions.map(input.projectAssertion),
        causes: plan.causes.map(cause => ({ kind: cause.kind, ref: ref(cause.kind, cause.id) })),
        ...("plan" in activity ? { startsAtSeconds: activity.plan.startsAtSeconds, completionAtSeconds: activity.plan.completionAtSeconds,
          checkpointSeconds: activity.plan.checkpointSeconds, progress: structuredClone(activity.plan.progress), stages: structuredClone(activity.plan.stages) } : {}),
      },
      ...("plan" in activity ? { startedAtSeconds: activity.startedAtSeconds, completionAtSeconds: activity.completionAtSeconds,
        nextBoundaryAtSeconds: activity.nextBoundaryAtSeconds, stageIndex: activity.stageIndex, progress: structuredClone(activity.progress) }
        : { enqueuedAtSeconds: activity.enqueuedAtSeconds, ...(activity.status === "ready" ? { reservedAtSeconds: activity.reservedAtSeconds } : {}) }),
    }];
  }));
  const boundary = {
    fromElapsedSeconds: input.boundary.fromElapsedSeconds, toElapsedSeconds: input.boundary.toElapsedSeconds,
    deltaSeconds: input.boundary.deltaSeconds,
    reasons: input.boundary.reasons.map(reason => {
      if ("activityId" in reason) return { kind: reason.kind, activityRef: ref("activity", reason.activityId) };
      if ("timerId" in reason) return { kind: reason.kind, timerRef: ref("timer", reason.timerId) };
      if ("conditionId" in reason) return { kind: reason.kind, conditionRef: ref("condition", reason.conditionId) };
      return structuredClone(reason);
    }),
    dueActivityRefs: input.boundary.dueActivityIds.map(id => ref("activity", id)),
    dueTimerRefs: input.boundary.dueTimerIds.map(id => ref("timer", id)),
    dueConditionRefs: input.boundary.dueConditionIds.map(id => ref("condition", id)),
  };
  return { contractVersion: ACTIVITY_TEMPORAL_EVIDENCE,
    sourceHash: contentHash({ worldHash: input.worldHash, revision: input.revision, activities: input.activities, boundary: input.boundary }),
    boundary, activities };
}
