import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { planSelectorRequest } from "../../src/engine/mechanics/plan-source-selectors";
import { expandSharedBatchContexts, factorSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { assertSelectorSourcePreserved } from "./step-plan-selector-probe";

it("requires complete source equality after annotation removal, including facts and outer task values", () => {
  const contexts = ["a", "b"].map(id => ({ state: { fact: "original fact", actionSet: { assigned: [{ actionRef: `ref:action:${id}`,
    rawText: "Keep the gate guarded until the convoy arrives", allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }] } },
    referenceCatalog: { candidates: [{ kind: "entity", handle: `ref:entity:${id}`, allowedUses: ["target"] }] }, repair: null }));
  const baseline = { task: { cardinality: 2 }, state: factorSharedBatchContexts(contexts, "shared-json-v3") };
  const selected = planSelectorRequest({ profileId: "truth-engine", workloadId: "instance", batchId: "step", role: "truth-resolution", subjectId: "test", schemaName: "truth_resolution_plan_commit_batch",
    schema: resolutionPlanCommitDirectiveSchema, promptVersion: "test", system: "test", userPrompt: "test", context: baseline }).context as typeof baseline;
  expect(() => assertSelectorSourcePreserved(baseline, selected)).not.toThrow();
  const lostFact = structuredClone(selected), expanded = expandSharedBatchContexts(lostFact.state);
  (expanded[0]!.state as Record<string, unknown>).fact = "different fact";
  lostFact.state = factorSharedBatchContexts(expanded, "shared-json-v3");
  expect(() => assertSelectorSourcePreserved(baseline, lostFact)).toThrow("complete initial source");
  expect(() => assertSelectorSourcePreserved(baseline, { ...selected, task: { cardinality: 1 } })).toThrow("outer task");
  const corrupt = structuredClone(selected);
  (corrupt.state as SharedBatchContext).slots[0]!.contextHash = "unbound";
  expect(() => assertSelectorSourcePreserved(baseline, corrupt)).toThrow("binding changed");
});
