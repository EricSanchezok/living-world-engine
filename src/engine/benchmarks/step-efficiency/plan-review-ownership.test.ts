import { expect, it } from "vitest";
import { createTestModelCatalog, ScriptedModelProvider } from "../../testing/model-provider";
import { contentHash } from "../../models/model-audit";
import { createPlanReviewControls } from "./plan-review-controls";
import { sourceIntentReviewRequest } from "../../mechanics/plan-review-ownership";
import { reviewAdmittedResolutionRequests } from "./resolution-admission-review";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";

it("preserves full fixture evidence while distinguishing source goals from mutable assertions", async () => {
  const catalog = createTestModelCatalog(), controls = createPlanReviewControls(catalog);
  expect(controls).toHaveLength(12); expect(controls.filter(control => control.expected === "accept")).toHaveLength(6);
  expect(controls.filter(control => control.violation === "means-asserts-unavailable-result")).toHaveLength(3);
  expect(controls.filter(control => control.violation === "effect-asserts-unavailable-result")).toHaveLength(3);
  const requests = controls.map(control => sourceIntentReviewRequest(control.request));
  for (const [i, request] of requests.entries()) {
    expect(request.context).toBe(controls[i]!.request.context); expect(request.schema).toBe(controls[i]!.request.schema);
    expect(request.system).toContain(controls[i]!.request.system);
    expect(contentHash(request.context)).toBe(contentHash(controls[i]!.request.context));
  }
  const changed = { ...controls[0]!.request, context: structuredClone(controls[0]!.request.context) };
  (changed.context as { state: { candidateResolutionPlans: Array<{ goal: string }> } }).state.candidateResolutionPlans[0]!.goal = "Claim success";
  expect(() => sourceIntentReviewRequest(changed)).toThrow("exact source-owned intent");
  let calls = 0;
  const planRef = (context: unknown) => (context as { state: { candidateResolutionPlans: Array<{ planRef: string }> } }).state.candidateResolutionPlans[0]!.planRef;
  const result = await reviewAdmittedResolutionRequests(requests, new ScriptedModelProvider(({ context }) => {
    calls++;
    const contexts = expandSharedBatchContexts((context as { state: SharedBatchContext }).state);
    return { slots: contexts.map((entry, slot) => {
      const reference = planRef(entry), control = controls.find(value => planRef(value.request.context) === reference)!;
      return { slot, result: control.expected === "accept" ? { verdict: "accept", findings: [] }
        : { verdict: "reject", findings: [{ planRef: reference, code: "impact-overstated",
          message: "The proposal asserts a result before analysis-ready.", repairHint: "Remove the unsupported conclusive claim." }] } };
    }) };
  }, catalog, false), { maxPhysicalRequests: 1 });
  expect(calls).toBe(1); expect(result.rows.map(row => row.verdict), JSON.stringify(result.rows.map(row => row.error))).toEqual(controls.map(control => control.expected));
  expect(result.stepCommitted).toBe(false);
});
