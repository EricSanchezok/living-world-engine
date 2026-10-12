import { describe, expect, it } from "vitest";
import { applyJsonDelta, createJsonDelta } from "../json-delta";
import { contentHash } from "../../models/model-audit";
import type { JsonValue } from "../json";

describe("lossless journal deltas", () => {
  it("stores only changes while reconstructing arrays, removals and null values exactly", () => {
    const base = { immutable: "source".repeat(20_000), log: [{ id: 1, done: false }], obsolete: true, nested: { keep: null } };
    const result = { immutable: base.immutable, log: [{ id: 1, done: true }, { id: 2, done: false }], nested: { keep: null, add: [1, 2] } };
    const delta = createJsonDelta(base, result);
    expect(JSON.stringify(delta).length).toBeLessThan(1_000);
    expect(applyJsonDelta(JSON.parse(JSON.stringify(base)), JSON.parse(JSON.stringify(delta)))).toEqual(result);
    expect(base.log).toEqual([{ id: 1, done: false }]);
    expect(applyJsonDelta(result, createJsonDelta(result, base))).toEqual(base);
  });
  it("supports root replacements and explicit array shortening", () => {
    const values: JsonValue[] = [null, 3, true, "value", [], [1, { a: 2 }], { x: [3, 4, 5] }];
    for (const before of values) for (const after of values) expect(applyJsonDelta(before, createJsonDelta(before, after))).toEqual(after);
    expect(applyJsonDelta([1, 2, 3], createJsonDelta([1, 2, 3], [4]))).toEqual([4]);
  });
  it("rejects stale bases, altered results, inherited paths and sparse array writes", () => {
    const base = { list: [1], data: { value: 3 } }, delta = createJsonDelta(base, { ...base, list: [2] });
    expect(() => applyJsonDelta({ ...base, list: [0] }, delta)).toThrow("base mismatch");
    expect(() => applyJsonDelta(base, { ...delta, resultHash: contentHash("wrong") })).toThrow("result mismatch");
    for (const path of [["data", "__proto__", "polluted"], ["list", "2"], ["list", "length"]]) {
      expect(() => applyJsonDelta(base, { ...delta, changes: [{ kind: "set", path, value: true }] })).toThrow();
    }
    const own = JSON.parse('{"__proto__":{"safe":1}}');
    const next = JSON.parse('{"__proto__":{"safe":2},"constructor":null}');
    expect(applyJsonDelta(own, createJsonDelta(own, next))).toEqual(next);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
