import { expect, it } from "vitest";
import { z } from "zod";
import { planMeansSourceSelector } from "../../../mechanics/plan-source-selectors";
import { SOURCE_INDEXED_PLAN_MEANS } from "../../../mechanics/source-indexed-planning";
import { contentHash } from "../../../models/model-audit";
import { ModelOutputError, type StructuredModelRequest } from "../../../models/model-provider";
import { expandGlobalMeansContext, globalMeansPoolRequest, poolGlobalMeansContext } from "../global-means-pool";

function fixture() {
  const records = Array.from({ length: 8 }, (_, i) => ({ kind: "fact", ref: `ref:fact:${i}`,
    factEvidence: { recordHash: `${i}`, sourcePath: ["state", "canonicalTruth", "facts", `ref:fact:${i}`],
      record: { description: "An exact world description. ".repeat(100), value: { kind: "text", value: `private-${i}` } } },
    additionalField: [null, false, i, "é"] }));
  const actions = Array.from({ length: 49 }, (_, i) => ({ actionRef: `ref:action:${i}`, rawText: `act-${i}`, allowedMeansSources:
    [...records, records[0]!].map(record => ({ ...structuredClone(record), sourceSelector: planMeansSourceSelector(`ref:action:${i}`, { kind: record.kind, ref: record.ref }) })) }));
  return { task: { planningIndices: { meansContract: SOURCE_INDEXED_PLAN_MEANS }, resolutionScope: { mode: "global" }, planningWorklist: { actions: actions.map(action => ({ slot: 0,
    action: { ...structuredClone(action), allowedMeansSources: action.allowedMeansSources.map((row, sourcePosition) => ({ ...row, sourcePosition })) } })) } },
    state: { actionSet: { assigned: actions }, canonicalTruth: { facts: records } }, repair: null };
}

it("shares repeated global inventories without losing any action's selectors, duplicate rows or fact fields", () => {
  const source = fixture(), before = contentHash(source), pooled = poolGlobalMeansContext(source);
  expect(expandGlobalMeansContext(pooled)).toEqual(source);
  expect(contentHash(source)).toBe(before);
  expect(JSON.stringify(pooled).length).toBeLessThan(JSON.stringify(source).length / 8);
  const pool = pooled.meansSourcePool as { records: unknown[]; inventories: unknown[] };
  expect(pool.records).toHaveLength(8);
  expect(pool.inventories).toHaveLength(49);
  const restored = expandGlobalMeansContext(pooled) as typeof source;
  restored.state.actionSet.assigned[0]!.allowedMeansSources[0]!.factEvidence.record.description = "changed";
  expect(restored.state.actionSet.assigned[1]!.allowedMeansSources[0]!.factEvidence.record.description).not.toBe("changed");
  expect(expandGlobalMeansContext(pooled)).toEqual(source);
});

it("rejects unsupported positions, missing records, reordered menus and source drift", () => {
  const source = fixture();
  source.task.planningWorklist.actions[0]!.action.allowedMeansSources[0]!.sourcePosition = 5;
  expect(() => poolGlobalMeansContext(source)).toThrow("position");
  const wrongSelector = fixture();
  wrongSelector.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector = "m:invented";
  expect(() => poolGlobalMeansContext(wrongSelector)).toThrow("selector");
  for (const mutate of [
    (pool: { records: unknown[]; inventories: Array<{ actionRef: string; recordIndices: number[] }> }) => { pool.records.pop(); },
    (pool: { records: unknown[]; inventories: Array<{ actionRef: string; recordIndices: number[] }> }) => { pool.inventories[0]!.recordIndices.reverse(); },
    (pool: { records: unknown[]; inventories: Array<{ actionRef: string; recordIndices: number[] }> }) => { pool.inventories[0]!.actionRef = "ref:action:other-action"; },
  ]) {
    const pooled = poolGlobalMeansContext(fixture());
    mutate(pooled.meansSourcePool as Parameters<typeof mutate>[0]);
    expect(() => expandGlobalMeansContext(pooled)).toThrow();
  }
  const pooled = poolGlobalMeansContext(fixture());
  expect(() => poolGlobalMeansContext(pooled)).toThrow("repeated pool");
});

it("preserves canonical output decoding and its failures while leaving component requests unchanged", () => {
  const source = fixture();
  const schema = z.strictObject({ selected: z.string() });
  const request: StructuredModelRequest<z.infer<typeof schema>> = { profileId: "truth-engine", role: "truth-resolution",
    workloadId: "world", batchId: "step", subjectId: "component-global", schemaName: "truth_resolution_plan_commit", schema,
    promptVersion: "source", system: "Original system", userPrompt: "Original user", context: source,
    preprocessOutput: raw => {
      if (raw !== source.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector) throw new ModelOutputError("Original source selection failure", undefined, { rawValue: raw });
      return { value: { selected: source.state.actionSet.assigned[0]!.allowedMeansSources[0]!.ref }, symbolRepairs: [] };
    } };
  const adapted = globalMeansPoolRequest(request);
  expect(adapted.schema).toBe(request.schema);
  expect(adapted.wireJsonSchema).toBe(request.wireJsonSchema);
  expect(adapted.system).toBe(request.system);
  expect(adapted.preprocessOutput!(source.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector)).toEqual(request.preprocessOutput!(source.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector));
  expect(() => adapted.preprocessOutput!("m:1-0")).toThrow(ModelOutputError);
  const component = { ...request, context: { ...source, task: { ...source.task, resolutionScope: { mode: "component" } } } };
  expect(globalMeansPoolRequest(component)).toBe(component);
  const unindexed = { ...request, context: { ...source, task: { ...source.task, planningIndices: {} } } };
  expect(globalMeansPoolRequest(unindexed)).toBe(unindexed);
  (adapted.context as Record<string, unknown>).repair = { altered: true };
  expect(() => adapted.preprocessOutput!(source.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector)).toThrow("request source changed");
});
