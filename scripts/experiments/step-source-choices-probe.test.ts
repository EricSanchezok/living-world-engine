import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { dependentFieldsRequest } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { factorTypesRequest } from "../../src/engine/mechanics/resolution-factor-types";
import { flatPlanBatchRequest } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { planSelectorRequest } from "../../src/engine/mechanics/plan-source-selectors";
import { sourceBoundPlanChoicesRequest } from "../../src/engine/mechanics/source-bound-plan-choices";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../../src/engine/mechanics/truth-batch-provider";
import { promptBundle } from "../../src/engine/prompts";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, type ProbeRow } from "./step-state-prefix-probe";
import { assertSourceChoiceTransform, sourceChoicesDecision, withoutProbeNamespace } from "./step-source-choices-probe";

it("qualifies complete accounted candidate roots without claiming a measured baseline comparison", () => {
  const rows: ProbeRow[] = ["041", "007"].map(rootId => ({ rootId, arm: "D", complete: true,
    initialAdmittedActions: rootId === "041" ? 41 : 7, httpCalls: 1, totalTokens: 100, documentedKnownNanoCny: 1000 }));
  expect(sourceChoicesDecision(rows, false)).toBe("eligible-for-source-semantic-review-no-comparative-claim");
  for (const patch of [{ complete: false }, { initialAdmittedActions: 40 }, { initialAdmittedActions: 42 }]) expect(sourceChoicesDecision([{ ...rows[0]!, ...patch }, rows[1]!], false)).toBe("failed-first-call-admission");
  expect(sourceChoicesDecision(rows, true)).toBe("inconclusive");
  expect(sourceChoicesDecision([rows[0]!, rows[0]!], false)).toBe("inconclusive");
  for (const patch of [{ arm: "B" }, { httpCalls: 0 }, { httpCalls: 2 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(sourceChoicesDecision([{ ...rows[0]!, ...patch }, rows[1]!], false)).toBe("inconclusive");
  }
});

it("proves that the source-bound choice schema is the only change beyond an explicit cache namespace", () => {
  const prompt = promptBundle("truth-resolution");
  const contexts = ["a", "b"].map(id => ({ state: { actionSet: { assigned: [{ actionRef: `ref:action:${id}`, allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }] } },
    referenceCatalog: { candidates: [{ kind: "entity", handle: `ref:entity:${id}`, allowedUses: ["target"] }] } }));
  const original = { profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution" as const, subjectId: "test",
    schemaName: "truth_resolution_plan_commit_batch", schema: z.strictObject({ slots: z.array(z.strictObject({ slot: z.number(), result: resolutionPlanCommitDirectiveSchema })) }),
    promptVersion: prompt.version, system: prompt.system, userPrompt: `${prompt.userPrompt}\n${SHARED_SLOT_RESULT_INSTRUCTION}`,
    context: { state: factorSharedBatchContexts(contexts), task: { slots: [{ slot: 0 }, { slot: 1 }] } } };
  const base = flatPlanBatchRequest(planSelectorRequest(factorTypesRequest(dependentFieldsRequest(original)))), namespace = "a".repeat(64);
  const baseline = admissionRequestEvidence(cacheNamespaceRequest(base, namespace)), candidate = admissionRequestEvidence(cacheNamespaceRequest(sourceBoundPlanChoicesRequest(base), namespace));
  expect(() => assertSourceChoiceTransform(baseline, candidate, namespace)).not.toThrow();
  expect(withoutProbeNamespace(baseline, namespace)).toEqual(admissionRequestEvidence(base));
  expect(() => withoutProbeNamespace(baseline, "b".repeat(64))).toThrow("namespace mismatch");
  for (const patch of [{ context: {} }, { schema: { ...candidate.schema, title: "changed" } }, { jsonExamplePolicy: null }]) {
    expect(() => assertSourceChoiceTransform(baseline, { ...candidate, ...patch }, namespace)).toThrow("source or generation");
  }
  expect(() => assertSourceChoiceTransform(baseline, { ...candidate, userPrompt: candidate.userPrompt + "Drop a plan" }, namespace)).toThrow("exact bound schema");
  expect(() => assertSourceChoiceTransform(baseline, { ...candidate, wireJsonSchema: baseline.wireJsonSchema }, namespace)).toThrow("exact bound schema");
});
