import { describe, expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { factorSharedBatchContexts, expandSharedBatchContexts } from "../shared-batch-context";
import { directSlotTaskLayout } from "../direct-slot-task-layout";

describe("direct slot task layout", () => {
  const contexts = ["a", "b"].map((id) => ({ task: { assignment: { targetHandles: [`ref:action:${id}`] }, constraints: [id], resolutionScope: { selectedActionRefs: [id] } },
    state: { actionSet: { assigned: [{ actionRef: `ref:action:${id}`, text: `完整行动 ${id}` }], available: ["a", "b"] },
      dependencySet: { assigned: [{ actionRef: `ref:action:${id}`, requiredExistingRefs: [id] }] }, world: { hiddenFact: "unchanged" } },
    referenceCatalog: { version: 2, hash: id, candidates: [{ handle: id }] }, repair: null }));

  it("retains every source context while exposing only the matching slot's task and actions", () => {
    const state = factorSharedBatchContexts(contexts), envelope = { state, task: { slots: [] }, referenceCatalogs: ["a", "b"], execution: "snapshot" };
    const originalHash = contentHash(envelope);
    const result = directSlotTaskLayout(envelope);
    expect(result.state).toEqual(state);
    expect(expandSharedBatchContexts(result.state as typeof state)).toEqual(contexts);
    expect(result.execution).toBe("snapshot");
    expect(result.referenceCatalogs).toEqual(["a", "b"]);
    expect((result.task as { slots: unknown[] }).slots).toEqual(contexts.map((context, slot) => ({ ...context.task, slot,
      contextHash: state.slots[slot]!.contextHash, assignedActions: context.state.actionSet.assigned, assignedDependencies: context.state.dependencySet.assigned })));
    expect(contentHash(envelope)).toBe(originalHash);
    expect(contentHash(directSlotTaskLayout(JSON.parse(JSON.stringify(envelope))))).toBe(contentHash(result));
    expect(contentHash(directSlotTaskLayout(result))).toBe(contentHash(result));
  });

  it("rejects a swapped or altered context before creating authoritative-looking excerpts", () => {
    const batch = factorSharedBatchContexts(contexts);
    batch.slots.reverse();
    expect(() => directSlotTaskLayout({ task: {}, state: batch })).toThrow("order");
    const changed = factorSharedBatchContexts(contexts);
    changed.shared = { ...changed.shared, unauthorized: true };
    expect(() => directSlotTaskLayout({ task: {}, state: changed })).toThrow("binding");
  });
});
