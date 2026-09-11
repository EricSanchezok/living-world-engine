import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { dependentFieldsRequest } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { z } from "zod";
import { flatPlanBatchRequest } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../../src/engine/mechanics/truth-batch-provider";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";
import { promptBundle } from "../../src/engine/prompts";
import { assertFlatSourcePreserved, flatPlansDecision } from "./step-flat-plans-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import type { ProbeRow } from "./step-state-prefix-probe";

it("requires fully accounted paired first-call admission and nonincreasing tokens before semantic review", () => {
  const rows: ProbeRow[] = ["041", "007"].flatMap(rootId => ["B", "L"].map(arm => ({ rootId, arm, complete: true,
    initialAdmittedActions: rootId === "041" ? 41 : 7, httpCalls: 1, totalTokens: 100, documentedKnownNanoCny: 1000 })));
  expect(flatPlansDecision(rows, false)).toBe("eligible-for-source-semantic-review-no-first-call-gain");
  rows[0]!.initialAdmittedActions = 26; rows[0]!.complete = false;
  expect(flatPlansDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  rows[1]!.totalTokens = 101;
  expect(flatPlansDecision(rows, false)).toBe("failed-first-call-efficiency");
  rows[1]!.complete = false;
  expect(flatPlansDecision(rows, false)).toBe("failed-first-call-admission");
  expect(flatPlansDecision(rows, true)).toBe("inconclusive");
  expect(flatPlansDecision([rows[0]!, rows[0]!, ...rows.slice(2)], false)).toBe("inconclusive");
  for (const patch of [{ httpCalls: 0 }, { httpCalls: 2 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(flatPlansDecision([{ ...rows[0]!, ...patch }, ...rows.slice(1)], false)).toBe("inconclusive");
  }
});

it("freezes the exact flat wire transform, bound version, source context and generation contract", () => {
  const prompt = promptBundle("truth-resolution");
  const contexts = ["a", "b"].map(id => ({ state: { actionSet: { assigned: [{ actionRef: `ref:action:${id}` }] } } }));
  const source = dependentFieldsRequest({ profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution", subjectId: "test",
    schemaName: "truth_resolution_plan_commit_batch", schema: z.strictObject({ slots: z.array(z.strictObject({ slot: z.number(), result: resolutionPlanCommitDirectiveSchema })) }), promptVersion: prompt.version, system: prompt.system,
    userPrompt: `${prompt.userPrompt}\n${SHARED_SLOT_RESULT_INSTRUCTION}`, context: { state: factorSharedBatchContexts(contexts), task: { slots: [{ slot: 0 }, { slot: 1 }] } } });
  const baseline = admissionRequestEvidence(cacheNamespaceRequest(source, "a".repeat(64))), candidate = admissionRequestEvidence(cacheNamespaceRequest(flatPlanBatchRequest(source), "a".repeat(64)));
  expect(() => assertFlatSourcePreserved(baseline, candidate)).not.toThrow();
  for (const patch of [{ context: {} }, { system: candidate.system + "Skip waiting" }, { schema: { ...candidate.schema, title: "changed" } }, { jsonExamplePolicy: null }]) {
    expect(() => assertFlatSourcePreserved(baseline, { ...candidate, ...patch })).toThrow("source or request settings");
  }
  expect(() => assertFlatSourcePreserved(baseline, { ...candidate, userPrompt: candidate.userPrompt + " Skip waiting" })).toThrow("instructions");
  expect(() => assertFlatSourcePreserved(baseline, { ...candidate, promptVersion: candidate.promptVersion + "-changed" })).toThrow("instructions");
  expect(() => assertFlatSourcePreserved(baseline, { ...candidate, wireJsonSchema: baseline.wireJsonSchema })).toThrow("exact transform");
});
