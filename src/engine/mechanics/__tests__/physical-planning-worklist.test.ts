import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { serializeModelContext, SHARED_STATE_FIRST_LAYOUT } from "../../prompts/context-layout";
import { assertPhysicalPlanningWorklist, buildPhysicalPlanningWorklist, physicalPlanningWorklistRequest, withoutPhysicalPlanningWorklist, type PhysicalPlanningWorklist } from "../physical-planning-worklist";
import { expandSharedBatchContexts, factorSharedBatchContexts, type SharedBatchContext } from "../shared-batch-context";

function fixture(counts: number[], codec: "shared-json-v2" | "shared-json-v3" = "shared-json-v3") {
  const contexts = counts.map((count, slot) => ({ task: { assignment: { label: `slot-${slot}` }, constraints: ["Wait until the convoy arrives"] },
    state: { revision: 7, actionSet: { assigned: Array.from({ length: count }, (_, index) => ({ actionRef: `ref:action:${slot}-${index}`,
      actorRef: `ref:agent:${slot}`, rawText: "等待商队到来后交付全部物资；如果道路被封，原地守候。", goal: "Conditional delivery", means: null,
      allowedMeansSources: [{ kind: "action", ref: `ref:action:${slot}-${index}`, sourceSelector: `source-${slot}-${index}` }],
      futureField: { nested: [null, false, slot, index] } })), available: [{ actionRef: "ref:action:available-only", rawText: "Background action retained" }] } },
    referenceCatalog: { candidates: ["shared", `slot-${slot}`].map(id => ({ kind: "entity", handle: `ref:entity:${id}`, label: id,
      targetSelector: `e:${contentHash(`ref:entity:${id}`).slice(0, 12)}`, allowedUses: ["target"], meaning: "Full original catalog record", statePath: `state.entities.${id}` })) },
    repair: { previousOutput: { kind: "commit_plans", plans: [] }, issues: [{ path: ["plans", 0], message: "original evidence" }] } }));
  const context = counts.length === 1 ? contexts[0]! : { state: factorSharedBatchContexts(contexts, codec), task: { slots: counts.map((_, slot) => ({ slot, assignment: {}, constraints: [] })) } };
  const request: StructuredModelRequest<unknown> = { profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution", subjectId: "test",
    schemaName: counts.length === 1 ? "truth_resolution_plan_commit" : "truth_resolution_plan_commit_batch", schema: z.unknown(),
    promptVersion: "source-version", system: "Original system", userPrompt: "Original task", context,
    wireJsonSchema: { type: "object" }, preprocessOutput: value => ({ value, symbolRepairs: [] }),
    ...(counts.length > 1 ? { contextLayout: SHARED_STATE_FIRST_LAYOUT } : {}) };
  return { request, contexts };
}

it.each(["shared-json-v2", "shared-json-v3"] as const)("projects all41 original actions and every target membership without removing background (%s)", codec => {
  const { request, contexts } = fixture([2, 7, 5, 15, 4, 2, 1, 1, 1, 1, 1, 1], codec), before = contentHash(request.context);
  const next = physicalPlanningWorklistRequest(request), worklist = (next.context as { task: { planningWorklist: PhysicalPlanningWorklist } }).task.planningWorklist;
  expect(worklist.actionCount).toBe(41);
  expect(worklist.actions).toEqual(contexts.flatMap((entry, slot) => entry.state.actionSet.assigned.map(action => ({ slot, action }))));
  expect(worklist.sourceSlots).toEqual(contexts.map((entry, slot) => ({ slot, contextHash: contentHash(entry) })));
  expect(worklist.sourceContextHash).toBe(before);
  expect(worklist.targetChoices.find(choice => choice.label === "shared")!.slots).toEqual(contexts.map((_, slot) => slot));
  expect(worklist.targetChoices.filter(choice => choice.label !== "shared").map(choice => choice.slots)).toEqual(contexts.map((_, slot) => [slot]));
  expect(withoutPhysicalPlanningWorklist(next.context)).toEqual(request.context);
  expect(contentHash(request.context)).toBe(before); expect(() => assertPhysicalPlanningWorklist(next.context)).not.toThrow();
  expect(next.schema).toBe(request.schema); expect(next.wireJsonSchema).toBe(request.wireJsonSchema); expect(next.preprocessOutput).toBe(request.preprocessOutput);
  expect(next.system).toBe(request.system);
  const wire = JSON.parse(serializeModelContext(next.context, SHARED_STATE_FIRST_LAYOUT));
  expect(wire.task.planningWorklist).toEqual(worklist);
  expect(JSON.stringify(wire.state)).toContain("available-only");
  expect(worklist.actions.some(entry => entry.action.actionRef === "ref:action:available-only")).toBe(false);
});

it.each([{ counts: [1] }, { counts: [1, 1, 1, 1, 1, 1, 1] }])("binds exact singleton repair or seven-slot action inventories %j", ({ counts }) => {
  const { request, contexts } = fixture(counts);
  const next = physicalPlanningWorklistRequest(request), worklist = buildPhysicalPlanningWorklist(request.context);
  expect(worklist.actionCount).toBe(counts.length); expect(worklist.sourceSlots).toHaveLength(counts.length);
  expect(withoutPhysicalPlanningWorklist(next.context)).toEqual(request.context);
  expect(worklist.actions.map(entry => entry.action)).toEqual(contexts.flatMap(entry => entry.state.actionSet.assigned));
  expect(() => physicalPlanningWorklistRequest(next)).toThrow("repeated codec");
});

it("retains differing source labels without transferring their allowed slots", () => {
  const { request } = fixture([1, 1]);
  const context = request.context as { state: SharedBatchContext }, contexts = expandSharedBatchContexts(context.state);
  const catalog = contexts[1]!.referenceCatalog as { candidates: Array<{ label: string }> }; catalog.candidates[0]!.label = "Other original source label";
  context.state = factorSharedBatchContexts(contexts);
  const choices = buildPhysicalPlanningWorklist(context).targetChoices.filter(choice => choice.handle === "ref:entity:shared");
  expect(choices.map(choice => ({ label: choice.label, slots: choice.slots }))).toEqual([{ label: "shared", slots: [0] }, { label: "Other original source label", slots: [1] }]);
});

it("rejects altered source facts, action ownership and projected fields instead of accepting a stale worklist", () => {
  const { request } = fixture([1]);
  const next = physicalPlanningWorklistRequest(request), context = next.context as { task: { planningWorklist: PhysicalPlanningWorklist }; state: { revision: number } };
  const sourceChanged = structuredClone(context); sourceChanged.state.revision++;
  expect(() => assertPhysicalPlanningWorklist(sourceChanged)).toThrow("binding changed");
  const projectionChanged = structuredClone(context); projectionChanged.task.planningWorklist.actions[0]!.action.rawText = "different meaning";
  expect(() => assertPhysicalPlanningWorklist(projectionChanged)).toThrow("binding changed");
  const projectedSlots = structuredClone(context); projectedSlots.task.planningWorklist.targetChoices[0]!.slots.push(1);
  expect(() => assertPhysicalPlanningWorklist(projectedSlots)).toThrow("binding changed");
  expect(() => buildPhysicalPlanningWorklist(context)).toThrow("repeated projection");
  expect(() => withoutPhysicalPlanningWorklist(request.context)).toThrow("missing projection");
  const invalid = withoutPhysicalPlanningWorklist(next.context) as { state: { actionSet: { assigned: unknown[] } } };
  invalid.state.actionSet.assigned.push(invalid.state.actionSet.assigned[0]);
  expect(() => buildPhysicalPlanningWorklist(invalid)).toThrow("ambiguous");
  const unrelated = { ...request, role: "causal-verifier" as const }; expect(physicalPlanningWorklistRequest(unrelated)).toBe(unrelated);
});
