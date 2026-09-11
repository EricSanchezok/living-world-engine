import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import type { StructuredModelRequest } from "../../src/engine/models/model-provider";
import { admissionContextEvidence, admissionDecision, admissionRequestEvidence } from "./step-runtime-admission-probe";

it("requires complete admission or measured complete-output savings before semantic review", () => {
  const baseline = { arm: "B", complete: true, httpCalls: 2, totalTokens: 1000 };
  const candidate = { arm: "C", complete: true, httpCalls: 2, totalTokens: 900 };
  expect(admissionDecision([baseline, candidate], false)).toBe("eligible-for-source-semantic-review");
  expect(admissionDecision([baseline, { ...candidate, totalTokens: 901 }], false)).toBe("failed");
  expect(admissionDecision([baseline, { ...candidate, httpCalls: 3 }], false)).toBe("failed");
  expect(admissionDecision([baseline, { ...candidate, complete: false, totalTokens: 10 }], false)).toBe("failed");
  expect(admissionDecision([{ ...baseline, complete: false }, candidate], false)).toBe("eligible-for-source-semantic-review");
  expect(admissionDecision([baseline, { ...candidate, totalTokens: null }], false)).toBe("inconclusive");
  expect(admissionDecision([baseline, candidate], true)).toBe("inconclusive");
  expect(admissionDecision([candidate], false)).toBe("inconclusive");
});

it("compares complete contexts without modifying model input or overlooking lost evidence", () => {
  const original = { referenceCatalog: { hash: "ordered-original", candidates: [{ handle: "b", meaning: "Second" }, { handle: "a", meaning: "First" }] },
    state: { actors: [{ boundCanonicalEntityRefs: ["b", "a"] }], canonicalTruth: { facts: { stock: { quantity: 4 } } },
      actionSet: { assigned: [{ rawText: "Deliver all four units", allowedMeansSources: [{ kind: "fact", ref: "b" }, { kind: "action", ref: "a" }] }] } },
    task: { constraints: ["Keep all units"] } };
  const reordered = structuredClone(original), before = contentHash(original);
  reordered.referenceCatalog.candidates.reverse(); reordered.referenceCatalog.hash = "ordered-new";
  reordered.state.actors[0]!.boundCanonicalEntityRefs.reverse();
  reordered.state.actionSet.assigned[0]!.allowedMeansSources.reverse();
  expect(admissionContextEvidence(reordered)).toBe(admissionContextEvidence(original));
  expect(contentHash(original)).toBe(before);
  const changed = structuredClone(reordered); changed.state.canonicalTruth.facts.stock.quantity = 3;
  expect(admissionContextEvidence(changed)).not.toBe(admissionContextEvidence(original));
  const missing = structuredClone(reordered); missing.state.actionSet.assigned[0]!.allowedMeansSources.pop();
  expect(admissionContextEvidence(missing)).not.toBe(admissionContextEvidence(original));
  const meaning = structuredClone(reordered); meaning.task.constraints = [];
  expect(admissionContextEvidence(meaning)).not.toBe(admissionContextEvidence(original));
});

it("freezes output representation, rendering policy and registry with the complete request", () => {
  const request: StructuredModelRequest<unknown> = { workloadId: "instance", batchId: "prepare:1", subjectId: "component",
    role: "truth-resolution", profileId: "truth-deepseek", schemaName: "truth_resolution_plan_commit", schema: z.object({ value: z.string() }),
    promptVersion: "test@1", system: "Resolve", userPrompt: "All actions", context: { original: "all world data" }, modelRegistrySnapshotHash: "snapshot" };
  const original = contentHash(admissionRequestEvidence(request));
  for (const change of [{ wireJsonSchema: { type: "object" } }, { jsonExamplePolicy: "omit" as const },
    { system: "Changed instructions" }, { modelRegistrySnapshotHash: "other-snapshot" }, { context: { original: "incomplete world" } }]) {
    expect(contentHash(admissionRequestEvidence({ ...request, ...change }))).not.toBe(original);
  }
});
