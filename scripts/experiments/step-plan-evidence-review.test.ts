import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanVerificationSchema } from "../../src/engine/contracts/llm-schemas";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { restoreCapturedPlanVerifier } from "./step-plan-evidence-review";

it("restores the captured verifier byte contract without changing or narrowing its evidence", () => {
  const evidence = admissionRequestEvidence({ workloadId: "world", batchId: "advance", role: "causal-verifier", profileId: "truth",
    subjectId: "component-a", schemaName: "resolution_plan_verification", promptVersion: "original", system: "original system",
    userPrompt: "original instruction", context: { execution: { instanceId: "world", advanceId: "advance" }, state: { full: [1, 2, 3] } },
    schema: resolutionPlanVerificationSchema, modelRegistrySnapshotHash: "a".repeat(64) });
  const restored = restoreCapturedPlanVerifier(evidence);
  expect(admissionRequestEvidence(restored)).toEqual(evidence);
  expect(restored.context).not.toBe(evidence.context);
  expect(() => restoreCapturedPlanVerifier({ ...evidence, schema: z.toJSONSchema(z.object({})) })).toThrow("schema changed");
  expect(() => restoreCapturedPlanVerifier({ ...evidence, role: "truth-resolution" })).toThrow("stage");
  expect(() => restoreCapturedPlanVerifier({ ...evidence, jsonSyntaxRecovery: "unmatched-closers-v1" })).toThrow("losslessly");
  expect(() => restoreCapturedPlanVerifier({ ...evidence, context: { execution: { instanceId: "world" } } })).toThrow();
});
