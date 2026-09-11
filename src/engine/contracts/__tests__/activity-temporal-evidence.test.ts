import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { advanceTemporalState, createActivity, materializeTemporalPlan, pauseActivity,
  queueScheduledActivity, reserveQueuedActivity, selectTemporalBoundary, type TemporalPlanDraft } from "../../mechanics/temporal";
import { contentHash } from "../../models/model-audit";
import { buildCausalVerificationContext, buildResolutionPlanVerificationContext, buildTruthContext, createTruthReferenceResolver } from "../prompts";
import { ACTIVITY_TEMPORAL_NOTICE } from "../activity-temporal-evidence";
import type { ReactionDecision } from "../model";

function fixture(profileId = "ongoing-action", rawText = "Watch the courtyard and keep waiting for a signal.", basis: TemporalPlanDraft["basis"] = { kind: "profile" }) {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: createTestModelCatalog() });
  const state = structuredClone(definition.initialState), action = { id: `rt:action:${"a".repeat(64)}`, actorId: "player", baseRevision: state.revision,
    rawText, goal: rawText, means: null, targetIds: [] };
  const plan = materializeTemporalPlan({ id: "temporal-plan-test", actionId: action.id, actorId: action.actorId, rawText,
    startsAtSeconds: 0, profiles: state.truth.mechanics.temporalProfiles,
    draft: { profileId, basis, description: rawText, causes: [{ kind: "action", id: action.id }],
      continuationAssertions: [{ kind: "elapsed_seconds_compare", operator: "lt", value: 5000 }] } });
  const activity = createActivity({ id: `rt:activity:${"b".repeat(64)}`, plan, sourceAction: action });
  state.truth.activities = { [activity.id]: activity };
  const grounding = { kind: "action" as const, id: action.id, actorId: action.actorId, reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false };
  const boundary = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 10, activities: state.truth.activities, timers: {}, conditionExpiries: {} });
  const input: Parameters<typeof buildTruthContext>[0] = { definition, state,
    workset: { state, mode: "full", initialActions: [action], availableActions: [action], assignedActions: [action], availableDependencies: [grounding], assignedDependencies: [grounding] },
    reactionRequests: [], reactionDecisions: [], reactionWindow: "closed", committedCheckRequests: [], checkResults: [],
    committedRandomRequests: [], randomResults: [], commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [],
    temporalBoundary: boundary, instanceId: "instance", advanceId: "step", issues: [], stage: "resolution" };
  const resolver = createTruthReferenceResolver({ definition, state, actions: [action] });
  return { input, activity, action, resolver, handle: resolver.handleFor("activity", activity.id) };
}

type Context = { task: { constraints: string[] }; state: { temporalExecution?: {
  sourceHash: string; boundary: { dueActivityRefs: string[]; reasons: unknown[] }; activities: Record<string, Record<string, unknown>>;
} } };
const view = (input: Parameters<typeof buildTruthContext>[0]) => buildTruthContext({ ...input, temporalEvidence: input.temporalBoundary }) as Context;

it("preserves actual reaction evidence without interpreting keep as a reply or hiding unavailable actions", () => {
  const { input, action } = fixture();
  const common = { definition: input.definition, state: input.state, workset: input.workset,
    instanceId: input.instanceId, advanceId: input.advanceId, issues: [],
    checkRequests: [], checkResults: [], randomRequests: [], randomResults: [],
    commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [], assertionResults: [],
    mechanicResults: [], previousReport: null,
    proposal: { baseRevision: input.state.revision, outcomes: [], operations: [], events: [], observations: [], mechanicInvocations: [], decisionRequests: [] } };
  const project = (reactionDecisions?: ReactionDecision[]) => buildCausalVerificationContext({ ...common, reactionDecisions }) as {
    state: { reactionEvidence: { status: string; sourceHash: string | null; decisions: unknown[] }; [key: string]: unknown };
  };
  const keep: ReactionDecision = { requestId: "actual-onset-request", source: "model", agentId: action.actorId,
    baseRevision: input.state.revision, originalProposalId: action.id, kind: "keep", ongoingActivityDisposition: "continue" };
  const absent = project();
  expect(absent.state.reactionEvidence).toEqual({ status: "unavailable", sourceHash: null, decisions: [] });
  expect(project([]).state.reactionEvidence).toEqual({ status: "provided", sourceHash: contentHash([]), decisions: [] });
  const supplied = project([keep]);
  expect(supplied.state.reactionEvidence).toEqual({ status: "provided", sourceHash: contentHash([keep]), decisions: [{
    sourceIndex: 0, agentRef: "ref:agent:player", baseRevision: input.state.revision,
    originalActionRef: expect.any(String), source: "model", kind: "keep", ongoingActivityDisposition: "continue",
  }] });
  const replacement: ReactionDecision = { requestId: keep.requestId, source: "external", agentId: action.actorId,
    baseRevision: input.state.revision, originalProposalId: "not-in-current-workset", kind: "replace",
    replacementAction: { ...action, id: "deferred-replacement", rawText: "I will answer after checking the ledger.",
      targetIds: ["a-local-name-outside-this-workset"] } };
  const replaced = project([replacement]);
  expect(replaced.state.reactionEvidence).toMatchObject({ sourceHash: contentHash([replacement]), decisions: [{
    originalActionRef: null, source: "external", kind: "replace",
    replacementAction: { actionRef: null, rawText: replacement.replacementAction.rawText,
      targetLocalIds: replacement.replacementAction.targetIds },
  }] });
  for (const projected of [supplied, replaced, project([])]) {
    const withoutEvidence = structuredClone(projected);
    withoutEvidence.state.reactionEvidence = absent.state.reactionEvidence;
    expect(withoutEvidence).toEqual(absent);
  }
  expect(() => project([{ ...keep, baseRevision: input.state.revision + 1 }])).toThrow("stale revision");
  expect(keep.kind).toBe("keep");
});

it("preserves source context and cache isolation while supplying the same interval to both reviews", () => {
  const { input, activity, handle } = fixture();
  const sourceHash = contentHash(input), baseline = buildTruthContext(input);
  const context = view(input), evidence = context.state.temporalExecution!;
  expect(evidence.activities[handle]).toMatchObject({ status: "active", startedAtSeconds: 0, nextBoundaryAtSeconds: 60,
    completionAtSeconds: null, progress: null, plan: { mode: "ongoing", checkpointSeconds: 60, completionAtSeconds: null,
      continuationAssertions: [{ kind: "elapsed_seconds_compare", operator: "lt", value: 5000 }] } });
  expect(evidence.boundary.dueActivityRefs).toEqual([]);
  const restored = structuredClone(context); delete restored.state.temporalExecution; restored.task.constraints.pop();
  expect(restored).toEqual(baseline);
  expect(buildTruthContext(input)).toEqual(baseline);
  const common = { definition: input.definition, state: input.state, workset: input.workset, instanceId: input.instanceId,
    advanceId: input.advanceId, issues: [], temporalEvidence: input.temporalBoundary };
  const planReview = buildResolutionPlanVerificationContext({ ...common, plans: [], commitmentRounds: [] }) as Context;
  const causalReview = buildCausalVerificationContext({ ...common, checkRequests: [], checkResults: [], randomRequests: [], randomResults: [],
    commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [], assertionResults: [], mechanicResults: [], previousReport: null,
    proposal: { baseRevision: input.state.revision, outcomes: [], operations: [], events: [], observations: [], mechanicInvocations: [], decisionRequests: [] } }) as Context;
  for (const reviewed of [planReview, causalReview]) {
    expect(reviewed.state.temporalExecution).toEqual(evidence);
    expect(reviewed.task.constraints).toContain(ACTIVITY_TEMPORAL_NOTICE);
  }
  const checkpoint = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 60, activities: input.state.truth.activities, timers: {}, conditionExpiries: {} });
  const checkpointView = view({ ...input, temporalBoundary: checkpoint }).state.temporalExecution!;
  expect(checkpointView.boundary).toMatchObject({ dueActivityRefs: [handle], reasons: expect.arrayContaining([{ kind: "activity_checkpoint", activityRef: handle }]) });
  expect(checkpointView.sourceHash).not.toBe(evidence.sourceHash);
  expect(advanceTemporalState({ boundary: checkpoint, activities: input.state.truth.activities, timers: {} }).activities[activity.id]!.status).toBe("active");
  expect(contentHash(input)).toBe(sourceHash);
  expect(() => buildTruthContext({ ...input, temporalEvidence: checkpoint })).toThrow("boundary mismatch");
  expect(() => view({ ...input, temporalBoundary: { ...input.temporalBoundary, dueActivityIds: ["missing"] } })).toThrow();
});

it("projects paused, queued and reserved states without inventing a start time", () => {
  const { input, activity, handle } = fixture();
  const queued = queueScheduledActivity(activity, 0).activity;
  const states = [pauseActivity(activity, 0).activity, queued, reserveQueuedActivity(queued, 2).activity];
  for (const candidate of states) {
    const state = structuredClone(input.state); state.truth.activities = { [candidate.id]: candidate };
    const output = view({ ...input, state, workset: { ...input.workset, state } }).state.temporalExecution!.activities[handle]!;
    expect(output.status).toBe(candidate.status);
    if (candidate.status === "paused") expect(output.nextBoundaryAtSeconds).toBeNull();
    else {
      expect(output).not.toHaveProperty("startedAtSeconds");
      expect(output).toHaveProperty("enqueuedAtSeconds", 0);
      if (candidate.status === "ready") expect(output).toHaveProperty("reservedAtSeconds", 2);
    }
  }
});

it("preserves a completed fixed activity instead of treating its past boundary as ongoing", () => {
  const { input, activity, handle } = fixture("brief-action", "Look toward the courtyard.");
  const advanced = advanceTemporalState({ boundary: input.temporalBoundary, activities: input.state.truth.activities, timers: {} });
  const state = structuredClone(input.state); state.truth.activities = advanced.activities; state.truth.elapsedSeconds = 1;
  const boundary = selectTemporalBoundary({ elapsedSeconds: 1, maxAutonomousSpanSeconds: 10, activities: state.truth.activities, timers: {}, conditionExpiries: {} });
  const evidence = view({ ...input, state, workset: { ...input.workset, state }, temporalBoundary: boundary }).state.temporalExecution!;
  expect(advanced.activities[activity.id]!.status).toBe("completed");
  expect(evidence.activities[handle]).toMatchObject({ status: "completed", completionAtSeconds: 1, nextBoundaryAtSeconds: null });
  expect(evidence.boundary.dueActivityRefs).toEqual([]);
});

it.each([
  ["measured-travel", "Walk 5 km along the road.", { kind: "explicit_quantity", amount: 5, unit: "km", sourceText: "5 km" }],
  ["staged-treatment", "Examine the injury, then treat it.", { kind: "profile" }],
  ["explicit-duration", "Watch for 120 seconds.", { kind: "explicit_duration", seconds: 120, sourceText: "120 seconds" }],
] as const)("preserves the real %s profile and partial progress after advancement", (profileId, text, basis) => {
  const { input, activity, handle } = fixture(profileId, text, basis);
  const advanced = advanceTemporalState({ boundary: input.temporalBoundary, activities: input.state.truth.activities, timers: {} });
  const state = structuredClone(input.state); state.truth.activities = advanced.activities; state.truth.elapsedSeconds = input.temporalBoundary.toElapsedSeconds;
  const boundary = selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds, maxAutonomousSpanSeconds: 10, activities: state.truth.activities, timers: {}, conditionExpiries: {} });
  const output = view({ ...input, state, workset: { ...input.workset, state }, temporalBoundary: boundary }).state.temporalExecution!.activities[handle]!;
  const actual = advanced.activities[activity.id]!;
  expect(output).toMatchObject({ status: actual.status, updatedAtSeconds: actual.updatedAtSeconds, plan: { profileRef: `ref:temporal_profile:${profileId}`, mode: activity.plan.mode } });
  if ("plan" in actual) {
    expect(output.progress).toEqual(actual.progress);
    expect(output.stageIndex).toBe(actual.stageIndex);
    expect(output.nextBoundaryAtSeconds).toBe(actual.nextBoundaryAtSeconds);
    expect(output.plan).toMatchObject({ basis: expect.objectContaining({ kind: basis.kind }), stages: actual.plan.stages, progress: actual.plan.progress });
  }
});
