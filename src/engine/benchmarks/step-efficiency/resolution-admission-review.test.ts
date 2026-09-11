import { expect, it } from "vitest";
import { resolutionPlanVerificationSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { promptBundle } from "../../prompts";
import { createTestModelCatalog, ScriptedModelProvider } from "../../testing/model-provider";
import { reviewAdmittedResolutionRequests } from "./resolution-admission-review";

function requests(): StructuredModelRequest<unknown>[] {
  const prompt = promptBundle("resolution-plan-verifier");
  return [0, 1].map(slot => ({ profileId: "truth-deepseek", role: "causal-verifier", subjectId: `component-${slot}`,
    workloadId: "review-test", batchId: "prepare:1", schemaName: "resolution_plan_verification",
    schema: resolutionPlanVerificationSchema, promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt,
    context: { contractVersion: 1, roleContract: { role: "causal-verifier" }, execution: { instanceId: "review-test", advanceId: "prepare:1" },
      referenceCatalog: { version: 1, hash: `catalog-${slot}`, candidates: [0, 1].map(index => ({
      handle: `ref:plan:${index}`, kind: "plan", label: "Plan", meaning: "An admitted plan", allowedUses: ["target"], visibility: "role" })) },
      state: { originalMeaning: "A risky reconnaissance must not become certain success",
      candidateResolutionPlans: [{ planRef: `ref:plan:${slot}`, actionRef: `ref:action:${slot}` }] } } }));
}

it.each(["accept", "reject", "foreign-plan"])("reviews retained slots without generating new plans: %s", async kind => {
  let calls = 0;
  const inputs = requests(), hashes = inputs.map(request => contentHash(request.context));
  const provider = new ScriptedModelProvider(({ role, schemaName }) => {
    calls++; expect(role).toBe("causal-verifier"); expect(schemaName).toBe("resolution_plan_verification_batch");
    return { slots: [0, 1].map(slot => ({ slot, result: slot === 0 || kind === "accept" ? { verdict: "accept", findings: [] }
      : { verdict: "reject", findings: [{ planRef: kind === "foreign-plan" ? "ref:plan:0" : "ref:plan:1",
        code: "calibration-drift", message: "The plan treats uncertain reconnaissance as certain", repairHint: "Preserve grounded risk" }] } })) };
  }, createTestModelCatalog(), false);
  const result = await reviewAdmittedResolutionRequests(inputs, provider, { maxPhysicalRequests: 1 });
  if (calls === 0) throw new Error(JSON.stringify(result.rows.map(row => row.error)));
  expect(calls).toBe(1); expect(result.stepCommitted).toBe(false);
  expect(result.rows.map(row => row.verdict), JSON.stringify(result.rows.map(row => row.error))).toEqual(["accept", kind === "foreign-plan" ? "unknown" : kind]);
  expect(result.verdict).toBe(kind === "foreign-plan" ? "unknown" : kind);
  expect(inputs.map(request => contentHash(request.context))).toEqual(hashes);
});

it("rejects duplicate plan bindings before dispatch", async () => {
  const input = requests(); input[1]!.context = input[0]!.context;
  const provider = new ScriptedModelProvider(() => { throw new Error("must not call a model"); });
  await expect(reviewAdmittedResolutionRequests(input, provider, { maxPhysicalRequests: 1 })).rejects.toThrow("duplicate admitted plan");
});

it("preserves unknown verdicts when the bounded provider cannot return valid reviews", async () => {
  let calls = 0;
  const result = await reviewAdmittedResolutionRequests(requests(), new ScriptedModelProvider(() => { calls++; return { wrong: true }; }, createTestModelCatalog(), false),
    { maxPhysicalRequests: 1 });
  expect(calls).toBe(1); expect(result.verdict).toBe("unknown");
  expect(result.rows.every(row => row.verdict === "unknown" && row.review === null)).toBe(true);
});
