import { expect, it, vi } from "vitest";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import type { StructuredModelRequest } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { createTestModelAudit } from "../../src/engine/testing/model-provider";
import { resolutionPlanVerificationSchema } from "../../src/engine/contracts/llm-schemas";
import { bindSampledStructuredOutput, isContinuationRepair } from "./player-plan-continuation";
import { planStakesRequestEvidence } from "./player-plan-stakes-probe";

function sample() {
  const value = { plans: ["canonical-plan"] };
  const audit = createTestModelAudit("truth-resolution", "batch", `sha256:${contentHash("world")}`);
  audit.modelId = "deepseek-flash";
  audit.resolvedInference.thinking = "disabled";
  audit.invocations[0]!.responseHash = audit.invocations[0]!.normalizedOutputHash = contentHash(value);
  const preprocessOutput = vi.fn(() => { throw new Error("normalized evidence must not pass through the wire decoder again"); });
  const request: StructuredModelRequest<typeof value> = {
    workloadId: "world", batchId: "step", role: audit.role, subjectId: audit.subjectId, profileId: audit.profileId,
    modelInvocationId: audit.invocations[0]!.id, modelRegistrySnapshotHash: audit.registrySnapshotHash,
    schemaName: "truth_resolution_plan_commit_batch", promptVersion: audit.promptVersion,
    context: { source: "complete", repair: null }, system: "system", userPrompt: "task",
    schema: z.object({ plans: z.array(z.string()).min(1) }).strict(), preprocessOutput,
    wireJsonSchema: { type: "object", properties: { kind: { const: "plans" }, plans: { type: "array" } } },
  };
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  observer.emit({ event: "model.audit.persisted", hashes: { response: contentHash(value) }, payload: audit });
  observer.emit({ event: "model.structured_output.parsed", hashes: { response: contentHash(value) }, payload: value });
  return { request, events: observer.snapshot(), audit, value, evidence: planStakesRequestEvidence(request), preprocessOutput };
}

it("reuses verified canonical output and original audit without decoding or adding a transport", () => {
  const s = sample(), before = contentHash(s.events);
  const result = bindSampledStructuredOutput(s.request, s.evidence, s.events);
  expect(result).toEqual({ value: s.value, audit: s.audit });
  result.value.plans.push("caller mutation");
  result.audit.invocations[0]!.transports.push(result.audit.invocations[0]!.transports[0]!);
  expect(contentHash(s.events)).toBe(before);
  expect(s.preprocessOutput).not.toHaveBeenCalled();
});

it("rejects reordered wire requests, changed source, output tampering and rejected samples", () => {
  const s = sample();
  const changed = { ...s.request, wireJsonSchema: { type: "object", properties: { plans: { type: "array" }, kind: { const: "plans" } } } };
  expect(contentHash(planStakesRequestEvidence(changed))).toBe(contentHash(s.evidence));
  expect(() => bindSampledStructuredOutput(changed, s.evidence, s.events)).toThrow("request drift");
  for (const patch of [{ context: { source: "different", repair: null } }, { promptVersion: "different" }, { modelInvocationId: "different" }]) {
    expect(() => bindSampledStructuredOutput({ ...s.request, ...patch }, s.evidence, s.events)).toThrow();
  }
  const tampered = structuredClone(s.events);
  tampered[1]!.payload = { plans: ["invented plan"] };
  expect(() => bindSampledStructuredOutput(s.request, s.evidence, tampered)).toThrow("output hash mismatch");
  tampered[1]!.payload = { plans: [] };
  expect(() => bindSampledStructuredOutput(s.request, s.evidence, tampered)).toThrow();
  expect(() => bindSampledStructuredOutput(s.request, s.evidence, [...s.events, { ...s.events[1]!, event: "model.semantic.rejected" }])).toThrow("accepted physical result");
});

it("stops repairs in physical, logical and shared envelopes while retaining arbitrary world prose", () => {
  const request = { schemaName: "truth_transition_batch", context: { repair: null } };
  expect(isContinuationRepair(request)).toBe(false);
  expect(isContinuationRepair({ ...request, context: { state: { canonicalTruth: { repair: "repair a boat" } } } })).toBe(false);
  for (const context of [{ batchRepair: { attempt: 1 } }, { repair: { issues: [] } },
    { state: { shared: { repair: { previousOutput: {} } } } }, { state: { slots: [{ delta: { repair: { issues: ["bad"] } } }] } },
    { task: { slots: [{ repair: { target: "plan" } }] } }]) {
    expect(isContinuationRepair({ ...request, context })).toBe(true);
  }
  expect(isContinuationRepair({ ...request, correlation: { semanticRepairAttempt: 1 } })).toBe(true);
  expect(isContinuationRepair({ ...request, schemaName: "truth_resolution_plan_repair" })).toBe(true);
});

it("retains a recorded semantic rejection and its complete finding instead of redrawing or accepting it", () => {
  const s = sample();
  const value = resolutionPlanVerificationSchema.parse({ verdict: "reject", findings: [{ planRef: "ref:plan:original", code: "impact-overstated",
    message: "Recorded reviewer concern", repairHint: "Recorded repair instruction" }] });
  const audit = createTestModelAudit("causal-verifier", "review", `sha256:${contentHash("world")}`);
  audit.modelId = "deepseek-flash";
  audit.resolvedInference.thinking = "disabled";
  audit.invocations[0]!.responseHash = audit.invocations[0]!.normalizedOutputHash = contentHash(value);
  const request: StructuredModelRequest<typeof value> = { ...s.request, role: audit.role, subjectId: audit.subjectId,
    modelInvocationId: audit.invocations[0]!.id, schemaName: "resolution_plan_verification", schema: resolutionPlanVerificationSchema,
    wireJsonSchema: z.toJSONSchema(resolutionPlanVerificationSchema, { target: "draft-07" }) };
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  observer.emit({ event: "model.audit.persisted", hashes: { response: contentHash(value) }, payload: audit });
  observer.emit({ event: "model.structured_output.parsed", hashes: { response: contentHash(value) }, payload: value });
  expect(bindSampledStructuredOutput(request, planStakesRequestEvidence(request), observer.snapshot())).toEqual({ value, audit });
  expect(s.preprocessOutput).not.toHaveBeenCalled();
});
