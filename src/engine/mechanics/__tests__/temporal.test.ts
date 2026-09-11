import { describe, expect, it } from "vitest";
import path from "node:path";
import type { ActionOutcome, CausalRef } from "../../contracts/model";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import {
  advanceTemporalState,
  createActivity,
  cancelActivity,
  extractActionTemporalEvidence,
  explicitDurationSeconds,
  materializeModelTemporalBasis,
  materializeTemporalPlan,
  materializeTrustedTemporalPlan,
  pauseActivity,
  resumeActivity,
  reconcileTemporalOutcomes,
  selectTemporalBoundary,
  settleActivityContexts,
  temporalProfileEligibility,
  validateActivityState,
  validateActivityResources,
  validateTemporalPlan,
  validateTemporalProfile,
  type ActivityResourceDefinition,
  type TemporalPlanDraft,
  type TemporalPlan,
  type TemporalProfileDefinition,
  type WorldTimer,
} from "../temporal";

const actionCause: CausalRef[] = [{ kind: "action", id: "action-a" }];
const resources: Record<string, ActivityResourceDefinition> = {
  foreground: { id: "foreground", name: "前台行动", capacity: 1 },
};

function fixedProfile(overrides: Partial<Extract<TemporalProfileDefinition, { kind: "fixed" }>> = {}): TemporalProfileDefinition {
  return {
    id: "brief",
    name: "短动作",
    kind: "fixed",
    durationSeconds: 1,
    checkpointSeconds: 1,
    selection: { semanticTags: ["short"], evidenceRequirement: "none" },
    interruptible: true,
    reactionFallback: "continue_if_valid",
    resourceClaims: [{ resourceId: "foreground", amount: 1 }],
    ...overrides,
  };
}

function draft(profileId: string, basis: TemporalPlanDraft["basis"] = { kind: "profile" }): TemporalPlanDraft {
  return {
    profileId,
    basis,
    description: "执行行动",
    continuationAssertions: [],
    causes: actionCause,
  };
}

function rateProfile(overrides: Partial<Extract<TemporalProfileDefinition, { kind: "rate" }>> = {}): TemporalProfileDefinition {
  return {
    id: "road-travel",
    name: "道路步行",
    kind: "rate",
    unit: "km",
    unitAliases: ["公里", "kilometers", "kilometres"],
    unitsPerPeriod: 5,
    periodSeconds: 3_600,
    checkpointUnits: 1,
    selection: { semanticTags: ["travel"], evidenceRequirement: "explicit_profile_quantity" },
    interruptible: true,
    reactionFallback: "continue_if_valid",
    resourceClaims: [{ resourceId: "foreground", amount: 1 }],
    ...overrides,
  };
}

function sourceAction(plan: TemporalPlan) {
  return {
    id: plan.actionId,
    actorId: plan.actorId,
    baseRevision: 0,
    rawText: plan.description,
    goal: plan.description,
    means: null,
    targetIds: [],
  };
}

describe("event-boundary temporal kernel", () => {
  it("settles multiple activities against both world phases without exposing mutable source evidence", () => {
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: createTestModelCatalog(),
    });
    const pre = structuredClone(definition.initialState);
    const fact = Object.values(pre.truth.facts)[0]!;
    expect(fact).toBeDefined();
    fact.value = { kind: "text", value: "open" };
    const profile = fixedProfile({ durationSeconds: 10, checkpointSeconds: 10 });
    const activities = ["player", "keeper"].map((actorId, index) => {
      const plan = materializeTemporalPlan({ id: `plan-${actorId}`, actionId: `action-${actorId}`, actorId,
        rawText: "Maintain the current action", startsAtSeconds: 0, profiles: { brief: profile },
        draft: { ...draft("brief"), continuationAssertions: index === 0
          ? [{ kind: "elapsed_seconds_compare", operator: "lt", value: 1 }]
          : [{ kind: "fact_matches", factId: fact.id, expected: structuredClone(fact.value) }] },
      });
      return createActivity({ id: `${index}-${actorId}`, plan, sourceAction: sourceAction(plan) });
    });
    pre.truth.activities = Object.fromEntries(activities.map(activity => [activity.id, activity]));
    const boundary = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1,
      activities: pre.truth.activities, timers: {}, conditionExpiries: {},
    });
    const temporal = advanceTemporalState({ boundary, activities: pre.truth.activities, timers: {} });
    const post = structuredClone(pre);
    post.truth.elapsedSeconds = boundary.toElapsedSeconds;
    post.truth.activities = structuredClone(temporal.activities);
    const input = { preTransitionState: pre, state: post, temporal,
      activityIds: activities.map(activity => activity.id).reverse(),
      relevantObserverIds: new Set(["keeper"]), preserveActiveActivityIds: new Set<string>(),
    };
    const before = structuredClone(input);
    const result = settleActivityContexts(input);
    expect(result.dispositions).toMatchObject([
      { activityId: "0-player", kind: "block", assertionResults: [
        { phase: "pre_transition", passed: true }, { phase: "post_transition", passed: false },
      ] },
      { activityId: "1-keeper", kind: "pause", assertionResults: [
        { phase: "pre_transition", passed: true }, { phase: "post_transition", passed: true },
      ] },
    ]);
    expect(result.temporal.activities["0-player"]!.status).toBe("blocked");
    expect(result.temporal.activities["1-keeper"]!.status).toBe("paused");
    const observed = result.dispositions[1]!.assertionResults[1]!.observed as { kind: string; value: string };
    observed.value = "modified by evidence consumer";
    result.temporal.activities["1-keeper"]!.sourceAction.rawText = "modified by result consumer";
    expect(input).toEqual(before);
    post.truth.facts[fact.id]!.value = { kind: "text", value: "closed" };
    expect(settleActivityContexts(input).dispositions[1]).toMatchObject({ kind: "block", assertionResults: [
      { phase: "pre_transition", passed: true }, { phase: "post_transition", passed: false },
    ] });
  });

  it("permits authored reaction fallbacks only on interruptible profiles", () => {
    expect(() => validateTemporalProfile(fixedProfile({ reactionFallback: "pause" }), resources)).not.toThrow();
    expect(() => validateTemporalProfile(fixedProfile({
      interruptible: false,
      reactionFallback: "cancel",
    }), resources)).toThrow("non-interruptible");
  });

  it("recognizes grounded Chinese and English explicit durations", () => {
    expect(explicitDurationSeconds("我要睡一天觉")).toBe(86_400);
    expect(explicitDurationSeconds("wait 1.5 hours")).toBe(5_400);
    expect(explicitDurationSeconds("休息半小时")).toBe(1_800);
    expect(explicitDurationSeconds("走到城镇")).toBeNull();
  });

  it("does not turn deadlines or maximum intervals into exact action durations", () => {
    for (const text of ["提交提案：要求三十日内成立委员会。", "三十日以内答复", "最多休息不超过两小时", "至多两小时",
      "Submit a proposal requiring a committee within 30 days.", "Reply within the next 2 hours.", "Rest for at most 2 hours.",
      "Rest for up to 2 hours.", "Rest for no more than 2 hours.", "Rest for less than 2 hours."]) {
      expect(explicitDurationSeconds(text), text).toBeNull();
    }
    expect(explicitDurationSeconds("休息两小时后走10公里")).toBe(7_200);
    expect(explicitDurationSeconds("工作三十日")).toBe(2_592_000);
    expect(explicitDurationSeconds("Work for 30 days.")).toBe(2_592_000);
    const text = "三十日内提交答复，先休息十分钟。";
    const evidence = extractActionTemporalEvidence(text, {});
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ sourceText: "十分钟", seconds: 600, start: text.indexOf("十分钟"), end: text.indexOf("十分钟") + 3 });
  });

  it("rejects a deadline-derived schedule at eligibility, model materialization and the temporal kernel", () => {
    const profile = fixedProfile({ id: "explicit-duration",
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" } });
    const rawText = "向 Tyrilas 提交一份书面提案：要求三十日内成立由总督、议会和市民代表三方共同监管的过渡委员会，设定可核验的安全指标和交权截止日期，同时要求 Corvin 停止街头游说。";
    const profiles = { [profile.id]: profile };
    const evidence = extractActionTemporalEvidence(rawText, profiles);
    expect(temporalProfileEligibility(profile, evidence)).toMatchObject({ eligible: false, rejectionCode: "missing_explicit_duration" });
    expect(() => materializeModelTemporalBasis(profile, { kind: "action_text_evidence", evidenceKey: "duration:21:24" }, evidence)).toThrow(/ineligible/u);
    expect(() => materializeTemporalPlan({ id: "deadline-mutant", actionId: "proposal", actorId: "author", rawText,
      startsAtSeconds: 0, profiles, draft: draft(profile.id, { kind: "explicit_duration", seconds: 2_592_000, sourceText: "三十日" }) })).toThrow(/not grounded/u);
  });

  it("keeps travel-distance descriptions out of exact action timing while retaining actual durations", () => {
    for (const text of ["在距城堡半天路程处停下列队。", "在离港口两小时的航程处停船。", "在距城镇三小时车程处休息。",
      "Stop at a camp 2 hours away from the fortress.", "Wait at a village 3 hours' walk from the harbor.",
      "Assemble at a pass 2 days’ journey from the city."]) {
      expect(explicitDurationSeconds(text), text).toBeNull();
    }
    for (const [text, seconds] of [["行军半天后停下", 43200], ["驱车两小时到村庄", 7200],
      ["Walk for 2 hours, then halt.", 7200], ["Sail for 3 hours.", 10800]] as const) {
      expect(explicitDurationSeconds(text), text).toBe(seconds);
    }
    const text = "在距城堡半天路程处休息两小时。";
    expect(extractActionTemporalEvidence(text, {})).toMatchObject([{ sourceText: "两小时", seconds: 7200,
      start: text.indexOf("两小时"), end: text.indexOf("两小时") + 3 }]);
  });

  it("rejects the recorded half-day-location schedule at eligibility and both temporal materializers", () => {
    const profile = fixedProfile({ id: "explicit-duration",
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" } });
    const rawText = "在距 Blackoak 半天路程处停下列队，先派两名可靠斥候确认城堡外哨位与使者接待位置，同时向纵队宣布接触条件：只承认能给出具体下令者姓名和时间线索的答复方。";
    const profiles = { [profile.id]: profile }, evidence = extractActionTemporalEvidence(rawText, profiles);
    expect(temporalProfileEligibility(profile, evidence)).toMatchObject({ eligible: false, rejectionCode: "missing_explicit_duration" });
    const start = rawText.indexOf("半天");
    expect(() => materializeModelTemporalBasis(profile, { kind: "action_text_evidence", evidenceKey: `duration:${start}:${start + 2}` }, evidence)).toThrow(/ineligible/u);
    expect(() => materializeTemporalPlan({ id: "spatial-duration-mutant", actionId: "proposal", actorId: "author", rawText,
      startsAtSeconds: 0, profiles, draft: draft(profile.id, { kind: "explicit_duration", seconds: 43200, sourceText: "半天" }) })).toThrow(/not grounded/u);
  });

  it("extracts exact temporal spans and makes rate eligibility deterministic", () => {
    const explicit = fixedProfile({
      id: "explicit-rest",
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" },
    });
    const road = rateProfile();
    const profiles = { [explicit.id]: explicit, [road.id]: road };
    const evidence = extractActionTemporalEvidence("先休息1.5小时，再沿路走 12公里。", profiles);

    expect(evidence).toEqual([
      expect.objectContaining({
        key: "duration:3:8",
        kind: "duration",
        sourceText: "1.5小时",
        start: 3,
        end: 8,
        seconds: 5_400,
        compatibleProfileIds: ["explicit-rest"],
      }),
      expect.objectContaining({
        key: "quantity:14:18:km",
        kind: "quantity",
        sourceText: "12公里",
        start: 14,
        end: 18,
        amount: 12,
        unit: "km",
        compatibleProfileIds: ["road-travel"],
      }),
    ]);
    expect(temporalProfileEligibility(road, evidence)).toEqual({
      eligible: true,
      evidenceRequirement: "explicit_profile_quantity",
      evidenceKeys: ["quantity:14:18:km"],
      rejectionCode: null,
    });
    expect(temporalProfileEligibility(road, extractActionTemporalEvidence("沿道路前往城镇", profiles)))
      .toEqual({
        eligible: false,
        evidenceRequirement: "explicit_profile_quantity",
        evidenceKeys: [],
        rejectionCode: "missing_explicit_quantity",
      });
    expect(temporalProfileEligibility(explicit, extractActionTemporalEvidence("休息片刻", profiles)))
      .toEqual({
        eligible: false,
        evidenceRequirement: "explicit_duration",
        evidenceKeys: [],
        rejectionCode: "missing_explicit_duration",
      });
  });

  it("materializes only an evidence key compatible with the selected profile", () => {
    const explicit = fixedProfile({
      id: "explicit-rest",
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" },
    });
    const road = rateProfile();
    const profiles = { [explicit.id]: explicit, [road.id]: road };
    const evidence = extractActionTemporalEvidence("休息两小时后走10公里", profiles);
    const duration = evidence.find((candidate) => candidate.kind === "duration")!;
    const quantity = evidence.find((candidate) => candidate.kind === "quantity")!;

    expect(materializeModelTemporalBasis(explicit, {
      kind: "action_text_evidence",
      evidenceKey: duration.key,
    }, evidence)).toEqual({ kind: "explicit_duration", seconds: 7_200, sourceText: "两小时" });
    expect(materializeModelTemporalBasis(road, {
      kind: "action_text_evidence",
      evidenceKey: quantity.key,
    }, evidence)).toEqual({ kind: "explicit_quantity", amount: 10, unit: "km", sourceText: "10公里" });
    expect(() => materializeModelTemporalBasis(road, {
      kind: "action_text_evidence",
      evidenceKey: duration.key,
    }, evidence)).toThrow("incompatible");
    expect(() => materializeModelTemporalBasis(road, { kind: "profile" }, evidence))
      .toThrow("requires an action_text_evidence");
  });

  it("materializes fixed and explicit-duration plans without model-owned clock writes", () => {
    const explicit = fixedProfile({
      id: "explicit-rest",
      name: "明确休息",
      durationSeconds: 60,
      checkpointSeconds: 3_600,
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" },
    });
    validateTemporalProfile(explicit, resources);
    const plan = materializeTemporalPlan({
      id: "plan-a",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "我要睡一天觉",
      startsAtSeconds: 100,
      draft: draft("explicit-rest", {
        kind: "explicit_duration",
        seconds: 86_400,
        sourceText: "一天",
      }),
      profiles: { "explicit-rest": explicit },
    });
    expect(plan.completionAtSeconds).toBe(86_500);
    expect(plan.checkpointSeconds).toBe(3_600);
    expect(() => materializeTemporalPlan({
      id: "plan-b",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "我要睡一天觉",
      startsAtSeconds: 100,
      draft: draft("explicit-rest", {
        kind: "explicit_duration",
        seconds: 3_600,
        sourceText: "一天",
      }),
      profiles: { "explicit-rest": explicit },
    })).toThrow("not grounded");
  });

  it("re-derives persisted schedules and source grounding at the canonical boundary", () => {
    const explicit = fixedProfile({
      id: "explicit-rest",
      name: "明确休息",
      durationSeconds: 60,
      checkpointSeconds: 3_600,
      selection: { semanticTags: ["explicit-duration"], evidenceRequirement: "explicit_duration" },
    });
    const plan = materializeTemporalPlan({
      id: "plan-rest",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "我要睡一天觉",
      startsAtSeconds: 100,
      draft: draft("explicit-rest", {
        kind: "explicit_duration",
        seconds: 86_400,
        sourceText: "一天",
      }),
      profiles: { "explicit-rest": explicit },
    });
    const action = { ...sourceAction(plan), rawText: "我要睡一天觉" };
    const activity = createActivity({ id: "activity-rest", plan, sourceAction: action });
    expect(() => validateActivityState(
      activity,
      100,
      { "explicit-rest": explicit },
      resources,
    )).not.toThrow();

    const forgedSchedule = structuredClone(plan);
    forgedSchedule.completionAtSeconds = 101;
    expect(() => validateTemporalPlan(
      forgedSchedule,
      { "explicit-rest": explicit },
      resources,
    )).toThrow("trusted profile schedule");

    const forgedSource = structuredClone(activity);
    forgedSource.sourceAction.rawText = "我要休息";
    expect(() => validateActivityState(
      forgedSource,
      100,
      { "explicit-rest": explicit },
      resources,
    )).toThrow("not grounded");
  });

  it("accepts only self-consistent Rule Package temporal results with mechanic provenance", () => {
    const profile = fixedProfile({ durationSeconds: 10, checkpointSeconds: 5 });
    const plan = materializeTrustedTemporalPlan({
      id: "plan-mechanic",
      actionId: "action-a",
      actorId: "agent-a",
      startsAtSeconds: 20,
      profile,
      invocationId: "invoke-a",
      durationSeconds: 7,
      checkpointSeconds: 2,
      progress: null,
      description: "规则结算",
      causes: [{ kind: "mechanic", id: "invoke-a" }],
    });
    expect(() => validateTemporalPlan(plan, { brief: profile }, resources)).not.toThrow();
    const forged = structuredClone(plan);
    forged.completionAtSeconds = 99;
    expect(() => validateTemporalPlan(forged, { brief: profile }, resources))
      .toThrow("mechanic result");
    const unproven = structuredClone(plan);
    unproven.causes = actionCause;
    expect(() => validateTemporalPlan(unproven, { brief: profile }, resources))
      .toThrow("untrusted mechanic basis");
  });

  it("derives rate duration and progress from an explicit action quantity", () => {
    const travel = rateProfile({ checkpointUnits: 10 });
    validateTemporalProfile(travel, resources);
    const plan = materializeTemporalPlan({
      id: "plan-travel",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "沿道路走到100公里外的城镇",
      startsAtSeconds: 0,
      draft: draft("road-travel", {
        kind: "explicit_quantity",
        amount: 100,
        unit: "km",
        sourceText: "100公里",
      }),
      profiles: { "road-travel": travel },
    });
    const activity = createActivity({ id: "activity-travel", plan, sourceAction: sourceAction(plan) });
    expect(plan.completionAtSeconds).toBe(72_000);
    expect(activity.nextBoundaryAtSeconds).toBe(7_200);
    const boundary = selectTemporalBoundary({
      elapsedSeconds: 0,
      maxAutonomousSpanSeconds: 30_000,
      activities: { [activity.id]: activity },
      timers: {},
      conditionExpiries: {},
    });
    const advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers: {} });
    expect(boundary.deltaSeconds).toBe(7_200);
    const advancedActivity = advanced.activities[activity.id]!;
    expect(advancedActivity.status).toBe("active");
    if (advancedActivity.status !== "active") throw new Error("travel Activity did not stay scheduled");
    expect(advancedActivity.progress).toEqual({ current: 10, target: 100, unit: "km" });
    expect(advanced.decisionPoints).toEqual([]);
  });

  it("chooses an earlier timer over a long activity checkpoint and fires all same-time timers", () => {
    const plan = materializeTemporalPlan({
      id: "plan-rest",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "休息",
      startsAtSeconds: 0,
      draft: draft("rest"),
      profiles: { rest: fixedProfile({ id: "rest", durationSeconds: 86_400, checkpointSeconds: 3_600 }) },
    });
    const activity = createActivity({ id: "activity-rest", plan, sourceAction: sourceAction(plan) });
    const timers: Record<string, WorldTimer> = Object.fromEntries(["fire", "deadline"].map((id) => [id, {
      id,
      description: id,
      createdAtSeconds: 0,
      dueAtSeconds: 600,
      status: "scheduled" as const,
      wakeAgentIds: id === "fire" ? ["agent-a"] : [],
      causes: actionCause,
      assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: 600 }],
    }]));
    const boundary = selectTemporalBoundary({
      elapsedSeconds: 0,
      maxAutonomousSpanSeconds: 10_000,
      activities: { [activity.id]: activity },
      timers,
      conditionExpiries: {},
    });
    expect(boundary.toElapsedSeconds).toBe(600);
    expect(boundary.dueTimerIds).toEqual(["deadline", "fire"]);
    const advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers });
    expect(advanced.timers.fire!.status).toBe("fired");
    expect(advanced.timers.deadline!.status).toBe("fired");
    const advancedActivity = advanced.activities[activity.id]!;
    expect(advancedActivity.status).toBe("active");
    if (advancedActivity.status !== "active") throw new Error("timer interrupted the Activity schedule");
    expect(advancedActivity.updatedAtSeconds).toBe(600);
    expect(advancedActivity.nextBoundaryAtSeconds).toBe(3_600);
    expect(advanced.decisionPoints).toContainEqual({
      agentId: "agent-a",
      reason: "timer",
      activityId: null,
      timerId: "fire",
    });
  });

  it("lets a short independent action finish while a long Activity remains occupied", () => {
    const longPlan = materializeTemporalPlan({
      id: "plan-sleep",
      actionId: "action-sleep",
      actorId: "agent-a",
      rawText: "睡到早上六点",
      startsAtSeconds: 0,
      draft: { ...draft("sleep"), causes: [{ kind: "action", id: "action-sleep" }] },
      profiles: { sleep: fixedProfile({ id: "sleep", durationSeconds: 28_800, checkpointSeconds: 28_800 }) },
    });
    const shortPlan = materializeTemporalPlan({
      id: "plan-step",
      actionId: "action-step",
      actorId: "agent-b",
      rawText: "向前走一步",
      startsAtSeconds: 0,
      draft: { ...draft("step"), causes: [{ kind: "action", id: "action-step" }] },
      profiles: { step: fixedProfile({ id: "step", durationSeconds: 2, checkpointSeconds: 2 }) },
    });
    const sleeping = createActivity({ id: "activity-sleep", plan: longPlan, sourceAction: sourceAction(longPlan) });
    const walking = createActivity({ id: "activity-step", plan: shortPlan, sourceAction: sourceAction(shortPlan) });
    const boundary = selectTemporalBoundary({
      elapsedSeconds: 0,
      maxAutonomousSpanSeconds: 30_000,
      activities: { [sleeping.id]: sleeping, [walking.id]: walking },
      timers: {},
      conditionExpiries: {},
    });
    const advanced = advanceTemporalState({
      boundary,
      activities: { [sleeping.id]: sleeping, [walking.id]: walking },
      timers: {},
    });

    expect(boundary).toMatchObject({ toElapsedSeconds: 2, deltaSeconds: 2, dueActivityIds: ["activity-step"] });
    expect(advanced.activities["activity-sleep"]).toMatchObject({
      status: "active",
      updatedAtSeconds: 2,
      nextBoundaryAtSeconds: 28_800,
    });
    expect(advanced.decisionPoints).toEqual([{
      agentId: "agent-b",
      reason: "activity_completed",
      activityId: "activity-step",
      timerId: null,
    }]);
  });

  it("advances staged work and creates a decision point only at completion", () => {
    const treatment: TemporalProfileDefinition = {
      id: "treatment",
      name: "分阶段治疗",
      kind: "staged",
      stages: [
        { id: "assessment", name: "检查", durationSeconds: 60, checkpointSeconds: 60 },
        { id: "treatment", name: "处理", durationSeconds: 300, checkpointSeconds: 120 },
      ],
      interruptible: true,
      reactionFallback: "continue_if_valid",
      resourceClaims: [{ resourceId: "foreground", amount: 1 }],
      selection: { semanticTags: ["staged-treatment"], evidenceRequirement: "none" },
    };
    const plan = materializeTemporalPlan({
      id: "plan-treatment",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "处理伤口",
      startsAtSeconds: 0,
      draft: draft("treatment"),
      profiles: { treatment },
    });
    let activity = createActivity({ id: "activity-treatment", plan, sourceAction: sourceAction(plan) });
    let boundary = selectTemporalBoundary({
      elapsedSeconds: 0,
      maxAutonomousSpanSeconds: 1_000,
      activities: { [activity.id]: activity },
      timers: {},
      conditionExpiries: {},
    });
    let advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers: {} });
    const firstAdvanced = advanced.activities[activity.id]!;
    if (firstAdvanced.status === "queued" || firstAdvanced.status === "ready") {
      throw new Error("staged Activity lost its schedule");
    }
    activity = firstAdvanced;
    expect(activity.stageIndex).toBe(1);
    expect(advanced.transitions[0]!.kind).toBe("stage_changed");
    expect(advanced.decisionPoints).toEqual([]);
    while (activity.status === "active") {
      boundary = selectTemporalBoundary({
        elapsedSeconds: activity.updatedAtSeconds,
        maxAutonomousSpanSeconds: 1_000,
        activities: { [activity.id]: activity },
        timers: {},
        conditionExpiries: {},
      });
      advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers: {} });
      const next = advanced.activities[activity.id]!;
      if (next.status === "queued" || next.status === "ready") throw new Error("staged Activity lost its schedule");
      activity = next;
    }
    expect(activity.updatedAtSeconds).toBe(360);
    expect(activity.status).toBe("completed");
    expect(advanced.decisionPoints).toEqual([{
      agentId: "agent-a",
      reason: "activity_completed",
      activityId: "activity-treatment",
      timerId: null,
    }]);
  });

  it("enforces per-Agent resource capacity and supports control-plane pause/resume", () => {
    const profile = fixedProfile({ durationSeconds: 10, checkpointSeconds: 5 });
    const make = (id: string) => {
      const plan = materializeTemporalPlan({
        id: `plan-${id}`,
        actionId: `action-${id}`,
        actorId: "agent-a",
        rawText: "行动",
        startsAtSeconds: 0,
        draft: { ...draft("brief"), causes: [{ kind: "action", id: `action-${id}` }] },
        profiles: { brief: profile },
      });
      return createActivity({ id, plan, sourceAction: sourceAction(plan) });
    };
    const first = make("first");
    const second = make("second");
    expect(() => validateActivityResources({ first, second }, resources)).toThrow("exceeds activity resource");
    const paused = pauseActivity(first, 0);
    expect(paused.activity.status).toBe("paused");
    expect(paused.activity.nextBoundaryAtSeconds).toBeNull();
    const resumed = resumeActivity(paused.activity, 0);
    expect(resumed.activity.status).toBe("active");
    expect(resumed.activity.nextBoundaryAtSeconds).toBe(5);
    const cancelled = cancelActivity(resumed.activity, 0);
    expect(cancelled.activity).toMatchObject({ status: "cancelled", nextBoundaryAtSeconds: null });
  });

  it("ends conditional work only when the boundary outcome satisfies it", () => {
    const conditional: TemporalProfileDefinition = {
      id: "daybreak",
      name: "等待天亮",
      kind: "conditional",
      checkEverySeconds: 60,
      interruptible: true,
      reactionFallback: "continue_if_valid",
      resourceClaims: [{ resourceId: "foreground", amount: 1 }],
      selection: { semanticTags: ["conditional-wait"], evidenceRequirement: "none" },
    };
    expect(() => materializeTemporalPlan({
      id: "plan-daybreak-invalid",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "等待天亮",
      startsAtSeconds: 0,
      draft: draft("daybreak"),
      profiles: { daybreak: conditional },
    })).toThrow("requires a continuation assertion");
    const plan = materializeTemporalPlan({
      id: "plan-daybreak",
      actionId: "action-a",
      actorId: "agent-a",
      rawText: "等待天亮",
      startsAtSeconds: 0,
      draft: {
        ...draft("daybreak"),
        continuationAssertions: [{
          kind: "fact_matches",
          factId: "daylight",
          expected: { kind: "boolean", value: true },
        }],
      },
      profiles: { daybreak: conditional },
    });
    const activity = createActivity({ id: "activity-daybreak", plan, sourceAction: sourceAction(plan) });
    const boundary = selectTemporalBoundary({
      elapsedSeconds: 0,
      maxAutonomousSpanSeconds: 300,
      activities: { [activity.id]: activity },
      timers: {},
      conditionExpiries: {},
    });
    const advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers: {} });
    const completed = reconcileTemporalOutcomes(advanced, [{
      proposalId: "action-a",
      status: "succeeded",
    } as ActionOutcome]);
    expect(completed.activities[activity.id]).toMatchObject({
      status: "completed",
      completionAtSeconds: 60,
      updatedAtSeconds: 60,
    });
    expect(completed.transitions[0]!.kind).toBe("completed");
    expect(completed.decisionPoints[0]).toMatchObject({ reason: "activity_completed" });
  });

  it("keeps goal work active across checkpoints and closes only its terminal outcome", () => {
    const profile: TemporalProfileDefinition = { id: "finite-work", name: "Finite work", kind: "goal", checkEverySeconds: 60,
      selection: { semanticTags: ["finite-work"], evidenceRequirement: "none" }, interruptible: true,
      reactionFallback: "continue_if_valid", resourceClaims: [{ resourceId: "foreground", amount: 1 }] };
    validateTemporalProfile(profile, resources);
    const profiles = { [profile.id]: profile };
    const plan = materializeTemporalPlan({ id: "plan-work", actionId: "action-a", actorId: "agent-a",
      rawText: "Inspect, repair and verify the boat.", startsAtSeconds: 0, profiles, draft: draft(profile.id) });
    let activity = createActivity({ id: "activity-work", plan, sourceAction: sourceAction(plan) });
    for (const [elapsedSeconds, status] of [[0, "continuing"], [60, "succeeded"]] as const) {
      const boundary = selectTemporalBoundary({ elapsedSeconds, maxAutonomousSpanSeconds: 300,
        activities: { [activity.id]: activity }, timers: {}, conditionExpiries: {} });
      expect(boundary.deltaSeconds).toBe(60);
      expect(boundary.reasons).toEqual([{ kind: "activity_checkpoint", activityId: activity.id }]);
      const advanced = advanceTemporalState({ boundary, activities: { [activity.id]: activity }, timers: {} });
      expect(advanced.activities[activity.id]!.status).toBe("active");
      expect(advanced.decisionPoints).toEqual([]);
      const reconciled = reconcileTemporalOutcomes(advanced, [{ proposalId: "action-a", status } as ActionOutcome]);
      activity = reconciled.activities[activity.id]! as typeof activity;
      validateActivityState(activity, boundary.toElapsedSeconds, profiles, resources);
      expect(activity.plan.continuationAssertions).toEqual([]);
      expect(activity.plan.completionAtSeconds).toBeNull();
      if (status === "continuing") {
        expect(activity).toMatchObject({ status: "active", completionAtSeconds: null, nextBoundaryAtSeconds: 120 });
        expect(reconciled.decisionPoints).toEqual([]);
      } else {
        expect(activity).toMatchObject({ status: "completed", completionAtSeconds: 120, nextBoundaryAtSeconds: null });
        expect(reconciled.decisionPoints).toHaveLength(1);
        expect(reconciled.decisionPoints[0]!.reason).toBe("activity_completed");
      }
    }
  });
});
