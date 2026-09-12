import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { createTestModelCatalog } from "../../src/engine/testing/model-provider";
import { createHistoryReplayBase } from "../../src/engine/runtime/history-replay";
import type { ActionOutcome, CausalAssertion } from "../../src/engine/contracts/model";
import { advanceTemporalState, createActivity, materializeTemporalPlan, reconcileTemporalOutcomes,
  selectTemporalBoundary, settleActivityContexts, type TemporalAdvanceResult } from "../../src/engine/mechanics/temporal";
import { finiteWorkWorldTemplate } from "./step-finite-work-world";
import { checkpointWorldTemplate } from "./step-checkpoint-world";
import { adjudicatedObjectiveState, adjudicatedObjectiveWorld, ADJUDICATED_OBJECTIVE_PROFILES } from "./adjudicated-objective-world";

const options = { seed: 47, modelCatalog: createTestModelCatalog() };

it("preserves the complete 48-agent world and every ordered field except two authored kinds", () => {
  const source = checkpointWorldTemplate(finiteWorkWorldTemplate(loadWorldTemplate("worlds/blackmarsh/world")));
  const text = JSON.stringify(source), candidate = adjudicatedObjectiveWorld(source, ADJUDICATED_OBJECTIVE_PROFILES);
  expect(JSON.stringify(source)).toBe(text);
  const before = buildWorldDefinition(source, options), after = buildWorldDefinition(candidate, options);
  expect(Object.keys(after.initialState.agents)).toHaveLength(48);
  const state = { ...structuredClone(before.initialState), revision: 1, historyBase: createHistoryReplayBase(before.initialState) };
  const overlay = adjudicatedObjectiveState(state, before, after, ADJUDICATED_OBJECTIVE_PROFILES);
  expect(overlay.state.agents).toEqual(state.agents);
  expect(overlay.state.truth.entities).toEqual(state.truth.entities);
  expect(overlay.provenance).toMatchObject({ gameplayCommit: false, savedStateMigration: false });
  for (const [id, seconds] of [["wait-until", 300], ["travel-until-arrival", 600]] as const) {
    expect(overlay.state.truth.mechanics.temporalProfiles[id]).toEqual({ ...state.truth.mechanics.temporalProfiles[id], kind: "goal" });
    expect(overlay.state.truth.mechanics.temporalProfiles[id]).toMatchObject({ checkEverySeconds: seconds });
  }
  const drift = structuredClone(after);
  drift.initialState.truth.mechanics.temporalProfiles["brief-action"].name += " changed";
  expect(() => adjudicatedObjectiveState(state, before, drift, ADJUDICATED_OBJECTIVE_PROFILES)).toThrow("unrelated mechanics");
  expect(() => adjudicatedObjectiveWorld(candidate, ADJUDICATED_OBJECTIVE_PROFILES)).toThrow("must be conditional");
  expect(() => adjudicatedObjectiveWorld(source, ["wait-until", "wait-until"])).toThrow("unique");
  expect(() => adjudicatedObjectiveState({ ...state, step: 1 }, before, after, ADJUDICATED_OBJECTIVE_PROFILES)).toThrow("first-action");
});

it("retains guarded timing, resources, outcome completion and failed-prerequisite blocking through the real temporal runtime", () => {
  const source = loadWorldTemplate("test/fixtures/open-world-script");
  const worlds = [source, adjudicatedObjectiveWorld(source, ["wait-condition"])].map(value => buildWorldDefinition(value, options));
  const factId = Object.keys(worlds[0]!.initialState.truth.facts)[0]!;
  const assertion: CausalAssertion = { kind: "fact_matches", factId, expected: { kind: "text", value: "permission-open" } };
  const action = { id: "action-wait", actorId: "player", baseRevision: 0,
    rawText: "Wait for the crew while permission remains open.", goal: "Wait for the crew while permission remains open.", means: null, targetIds: [] };
  const planFor = (index: number, assertions: CausalAssertion[]) => materializeTemporalPlan({ id: "plan-wait", actionId: action.id,
    actorId: action.actorId, rawText: action.rawText, startsAtSeconds: 0,
    profiles: worlds[index]!.initialState.truth.mechanics.temporalProfiles,
    draft: { profileId: "wait-condition", basis: { kind: "profile" }, description: action.rawText,
      continuationAssertions: assertions, causes: [{ kind: "action", id: action.id }] } });
  expect(() => planFor(0, [])).toThrow("requires a continuation assertion");
  expect(planFor(1, [])).toMatchObject({ mode: "goal", completionAtSeconds: null, checkpointSeconds: 60, continuationAssertions: [] });
  const normalizeMode = (value: TemporalAdvanceResult) => {
    const clone = structuredClone(value);
    for (const activity of Object.values(clone.activities)) if (activity.status !== "queued" && activity.status !== "ready") activity.plan.mode = "goal";
    return clone;
  };
  const cases: Array<{ outcome: ActionOutcome["status"]; preOpen: boolean; postOpen: boolean; status: string }> = [
    { outcome: "continuing", preOpen: true, postOpen: true, status: "active" },
    { outcome: "succeeded", preOpen: true, postOpen: true, status: "completed" },
    { outcome: "failed", preOpen: true, postOpen: true, status: "failed" },
    { outcome: "blocked", preOpen: true, postOpen: true, status: "blocked" },
    { outcome: "continuing", preOpen: false, postOpen: true, status: "blocked" },
    { outcome: "continuing", preOpen: true, postOpen: false, status: "blocked" },
  ];
  for (const testCase of cases) {
    const results = worlds.map((world, index) => {
      const pre = structuredClone(world.initialState), post = structuredClone(world.initialState);
      pre.truth.facts[factId]!.value = { kind: "text", value: testCase.preOpen ? "permission-open" : "permission-closed" };
      post.truth.facts[factId]!.value = { kind: "text", value: testCase.postOpen ? "permission-open" : "permission-closed" };
      const plan = planFor(index, [assertion]), activity = createActivity({ id: "activity-wait", plan, sourceAction: action });
      pre.truth.activities = { [activity.id]: activity };
      const boundary = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 300,
        activities: pre.truth.activities, timers: {}, conditionExpiries: {} });
      expect(boundary.toElapsedSeconds).toBe(60);
      const advanced = advanceTemporalState({ boundary, activities: pre.truth.activities, timers: {} });
      expect(advanced.activities[activity.id]!.status).toBe("active");
      const reconciled = reconcileTemporalOutcomes(advanced, [{ proposalId: action.id, status: testCase.outcome } as ActionOutcome]);
      const settled = settleActivityContexts({ preTransitionState: pre, state: post, temporal: reconciled,
        activityIds: [activity.id], relevantObserverIds: new Set(), preserveActiveActivityIds: new Set([activity.id]) });
      expect(settled.temporal.activities[activity.id]!.status).toBe(testCase.status);
      expect(settled.temporal.activities[activity.id]!.resourceClaims).toEqual(activity.resourceClaims);
      return { temporal: normalizeMode(settled.temporal), dispositions: settled.dispositions };
    });
    expect(results[1]).toEqual(results[0]);
  }
});
