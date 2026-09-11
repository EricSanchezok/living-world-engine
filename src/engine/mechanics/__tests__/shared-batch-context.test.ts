import { serialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import * as audit from "../../models/model-audit";
import { expandSharedBatchContexts, factorSharedBatchContexts, SHARED_BATCH_ORDER_CODEC, withSharedContextReuse } from "../shared-batch-context";

describe("lossless shared batch contexts", () => {
  it("reuses cloned input bytes while keeping every returned slot and invocation independent", () => {
    const contexts = [0, 1].map(slot => ({ slot, state: { facts: [{ amount: 3 }] } }));
    const batch = factorSharedBatchContexts(contexts, SHARED_BATCH_ORDER_CODEC);
    const original = JSON.stringify(batch), hash = vi.spyOn(audit, "contentHash");
    try {
      withSharedContextReuse(() => {
        const first = expandSharedBatchContexts(batch);
        hash.mockClear();
        const second = expandSharedBatchContexts(structuredClone(batch));
        expect(hash).not.toHaveBeenCalled();
        expect(second).toEqual(contexts);
        const mutable = first as typeof contexts;
        mutable[0]!.state.facts[0]!.amount = 999;
        expect(mutable[1]!.state.facts[0]!.amount).toBe(3);
        expect(second).toEqual(contexts);
        (second as typeof contexts)[1]!.state.facts.length = 0;
        expect(expandSharedBatchContexts(batch)).toEqual(contexts);
        expect(JSON.stringify(batch)).toBe(original);
      });
      hash.mockClear();
      expect(expandSharedBatchContexts(batch)).toEqual(contexts);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally { hash.mockRestore(); }
  });

  it("revalidates state, repair, identity, candidates, order and codec changes after a cache hit", () => {
    const batch = factorSharedBatchContexts([0, 1].map(slot => ({
      action: slot, snapshot: "v1", repair: null,
      referenceCatalog: { candidates: [{ handle: "fact:a", allowedUses: ["read"] }, { handle: "fact:b", allowedUses: ["read"] }] },
    })), SHARED_BATCH_ORDER_CODEC);
    withSharedContextReuse(() => {
      expandSharedBatchContexts(batch);
      for (const mutate of [
        (copy: typeof batch) => { copy.shared = { ...copy.shared, snapshot: "v2" }; },
        (copy: typeof batch) => { copy.shared = { ...copy.shared, repair: { previousOutput: "different" } }; },
        (copy: typeof batch) => { copy.slots[0]!.delta = { ...copy.slots[0]!.delta, action: 1 }; },
        (copy: typeof batch) => { copy.slots[0]!.contextHash = "0".repeat(64); },
        (copy: typeof batch) => { copy.slots.reverse(); },
        (copy: typeof batch) => { copy.catalogOrders!.o0!.reverse(); },
        (copy: typeof batch) => { copy.catalogOrders!.o0!.push("fact:c"); },
        (copy: typeof batch) => { copy.catalogOrders!.unused = []; },
        (copy: typeof batch) => { copy.slots[0]!.catalogOrderRef = "missing"; },
        (copy: typeof batch) => { copy.codec = "shared-json-v2"; },
      ]) {
        const changed = structuredClone(batch);
        mutate(changed);
        expect(() => expandSharedBatchContexts(changed)).toThrow();
      }
      // Mutating the very same object must also invalidate reuse.
      batch.shared = { ...batch.shared, snapshot: "v2" };
      expect(() => expandSharedBatchContexts(batch)).toThrow("binding");
    });
  });

  it("preserves distinct object insertion order even when canonical bindings match", () => {
    const batch = factorSharedBatchContexts([{ a: 1, b: 2, slot: 0 }, { a: 1, b: 2, slot: 1 }]);
    const reordered = structuredClone(batch);
    reordered.shared = { b: 2, a: 1 };
    const expected = expandSharedBatchContexts(reordered);
    expect(audit.contentHash(batch)).toBe(audit.contentHash(reordered));
    withSharedContextReuse(() => {
      const first = expandSharedBatchContexts(batch);
      const second = expandSharedBatchContexts(reordered);
      expect(JSON.stringify(second)).toBe(JSON.stringify(expected));
      expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
      expect(second).toEqual(first);
    });
  });

  it("bounds retained bytes, evicts old expansions and skips oversized entries", () => {
    const first = factorSharedBatchContexts([{ state: "first", slot: 0 }, { state: "first", slot: 1 }]);
    const second = factorSharedBatchContexts([{ state: "other", slot: 0 }, { state: "other", slot: 1 }]);
    const limit = serialize(expandSharedBatchContexts(first)).length;
    const hash = vi.spyOn(audit, "contentHash");
    try {
      withSharedContextReuse(() => {
        expandSharedBatchContexts(first);
        expandSharedBatchContexts(second);
        hash.mockClear();
        expect(expandSharedBatchContexts(first)).toEqual([{ state: "first", slot: 0 }, { state: "first", slot: 1 }]);
        expect(hash).toHaveBeenCalledTimes(2);
      }, limit);
      withSharedContextReuse(() => {
        expandSharedBatchContexts(first);
        hash.mockClear();
        expandSharedBatchContexts(first);
        expect(hash).toHaveBeenCalledTimes(2);
      }, limit - 1);
    } finally { hash.mockRestore(); }
  });

  it("ends reuse on return or throw, restores nested scopes and never crosses an await", async () => {
    const batch = factorSharedBatchContexts([{ slot: 0 }, { slot: 1 }]);
    const hash = vi.spyOn(audit, "contentHash");
    try {
      await withSharedContextReuse(async () => {
        expandSharedBatchContexts(batch);
        expect(() => withSharedContextReuse(() => {
          expandSharedBatchContexts(batch);
          throw new Error("construction stopped");
        })).toThrow("construction stopped");
        hash.mockClear();
        expandSharedBatchContexts(batch);
        expect(hash).not.toHaveBeenCalled();
        await Promise.resolve();
        hash.mockClear();
        expandSharedBatchContexts(batch);
        expect(hash).toHaveBeenCalledTimes(2);
      });
      expect(() => withSharedContextReuse(() => {
        expandSharedBatchContexts(batch);
        throw new Error("outer stopped");
      })).toThrow("outer stopped");
      hash.mockClear();
      expandSharedBatchContexts(batch);
      expect(hash).toHaveBeenCalledTimes(2);
    } finally { hash.mockRestore(); }
  });

  it("shares only identical catalog orders and preserves different scopes and orderings", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({ handle: `ref:fact:${index}`, allowedUses: ["read"] }));
    const contexts = Array.from({ length: 12 }, (_, slot) => ({
      referenceCatalog: { candidates: slot === 10 ? [...candidates].reverse() : slot === 11 ? candidates.slice(1) : candidates },
      state: { assigned: [slot], repair: slot ? null : { issues: ["retain source"] } },
    }));
    const baseline = factorSharedBatchContexts(contexts);
    const batch = factorSharedBatchContexts(contexts, SHARED_BATCH_ORDER_CODEC);
    expect(baseline.codec).toBe("shared-json-v2");
    expect(baseline).not.toHaveProperty("catalogOrders");
    expect(Object.keys(batch.catalogOrders!)).toEqual(["o0", "o1", "o2"]);
    expect(batch.slots.slice(0, 10).map(slot => slot.catalogOrderRef)).toEqual(Array(10).fill("o0"));
    expect(batch.slots.every(slot => slot.catalogCandidateOrder === undefined)).toBe(true);
    expect(expandSharedBatchContexts(JSON.parse(JSON.stringify(batch)))).toEqual(contexts);
    expect(JSON.stringify(batch).length).toBeLessThan(JSON.stringify(baseline).length * .7);
    for (const mutation of [
      (value: typeof batch) => { value.catalogOrders!.o0!.reverse(); },
      (value: typeof batch) => { value.catalogOrders!.o0!.push("ref:fact:extra"); },
      (value: typeof batch) => { value.slots[0]!.catalogOrderRef = "o1"; },
      (value: typeof batch) => { value.slots[0]!.catalogOrderRef = "missing"; },
      (value: typeof batch) => { value.catalogOrders!.unused = []; },
      (value: typeof batch) => { delete value.catalogOrders!.o0; },
      (value: typeof batch) => { value.slots[0]!.catalogCandidateOrder = []; },
      (value: typeof batch) => { value.codec = "shared-json-v2"; },
    ]) {
      const changed = structuredClone(batch); mutation(changed);
      expect(() => expandSharedBatchContexts(changed)).toThrow();
    }
  });

  it("round trips absent and empty catalogs without granting dictionary references", () => {
    const contexts = [{ state: { assigned: ["a"] } }, { referenceCatalog: { candidates: [] }, state: { assigned: ["b"] } }];
    const batch = factorSharedBatchContexts(contexts, SHARED_BATCH_ORDER_CODEC);
    expect(batch.catalogOrders).toEqual({ o0: [] });
    expect(batch.slots[0]).not.toHaveProperty("catalogOrderRef");
    expect(expandSharedBatchContexts(batch)).toEqual(contexts);
    const absent = factorSharedBatchContexts(contexts.slice(0, 1).concat(contexts.slice(0, 1)), SHARED_BATCH_ORDER_CODEC);
    expect(absent.catalogOrders).toEqual({});
    expect(expandSharedBatchContexts(absent)).toEqual([contexts[0], contexts[0]]);
  });

  it("shares nearly identical verifier catalogs without widening a slot or changing candidate order", () => {
    const common = Array.from({ length: 100 }, (_, index) => ({ handle: `ref:fact:${index}`, label: "existing fact".repeat(30), allowedUses: ["read"] }));
    const contexts = Array.from({ length: 5 }, (_, index) => ({
      referenceCatalog: { version: 2, hash: `catalog-${index}`, candidates: [
        ...common.slice(index), { handle: `ref:plan:${index}`, label: "own plan", allowedUses: ["verify"] }, ...common.slice(0, index),
      ] },
      state: { assigned: index },
    }));
    const batch = factorSharedBatchContexts(contexts);
    expect(expandSharedBatchContexts(JSON.parse(JSON.stringify(batch)))).toEqual(contexts);
    expect(JSON.stringify(batch).length).toBeLessThan(JSON.stringify(contexts).length * .35);
    const reordered = structuredClone(batch);
    reordered.slots[0]!.catalogCandidateOrder!.reverse();
    expect(() => expandSharedBatchContexts(reordered)).toThrow("binding");
    const widened = structuredClone(batch);
    widened.slots[0]!.catalogCandidateOrder!.push("ref:plan:1");
    expect(() => expandSharedBatchContexts(widened)).toThrow("coverage");
  });

  it("restores complete per-slot state, catalogs, repairs, empty objects and array order", () => {
    const common = { world: "世界".repeat(2000), facts: [{ handle: "ref:fact:1", value: 3 }] };
    const contexts = [
      { state: { common, assigned: ["a", "b"], empty: {} }, catalog: { candidates: ["a", "b"] }, repair: null, optional: null },
      { state: { common, assigned: ["b", "a"], empty: { value: 1 } }, catalog: { candidates: ["a"] }, repair: { issues: ["wrong type"] } },
    ];
    const batch = factorSharedBatchContexts(contexts);
    expect(expandSharedBatchContexts(JSON.parse(JSON.stringify(batch)))).toEqual(contexts);
    expect(JSON.stringify(batch).length).toBeLessThan(JSON.stringify(contexts).length * .6);
    expect(batch.slots[1]!.delta).not.toHaveProperty("optional");
    expect(batch.slots[0]!.delta.optional).toBeNull();
    expect(batch.slots[0]!.delta.catalog).toEqual(contexts[0]!.catalog);
  });

  it("rejects tampered state bindings, swapped slots and altered catalog contents", () => {
    const batch = factorSharedBatchContexts([
      { snapshot: "state-v1", catalog: ["allowed-a"], action: "a" },
      { snapshot: "state-v1", catalog: ["allowed-b"], action: "b" },
    ]);
    const state = structuredClone(batch);
    state.shared = { ...state.shared, snapshot: "state-v2" };
    expect(() => expandSharedBatchContexts(state)).toThrow("binding");
    const swapped = structuredClone(batch);
    swapped.slots.reverse();
    expect(() => expandSharedBatchContexts(swapped)).toThrow("order");
    const catalog = structuredClone(batch);
    catalog.slots[0]!.delta = { ...catalog.slots[0]!.delta, catalog: ["allowed-b"] };
    expect(() => expandSharedBatchContexts(catalog)).toThrow("binding");
  });
});
