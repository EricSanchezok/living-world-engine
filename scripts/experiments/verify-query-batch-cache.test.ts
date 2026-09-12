import { describe, expect, it } from "vitest";
import { queryCacheCounterexampleCovered } from "./verify-query-batch-cache";

describe("native query-cache comparison qualification", () => {
  it("does not qualify a full-warm control or unrelated drift as a partial-cache regression", () => {
    const warm = { partialMatchesCold: true, cache: { partial: { queryHits: 60, queryMisses: 0 } } };
    expect(queryCacheCounterexampleCovered(Array.from({ length: 5 }, () => warm))).toBe(false);
    expect(queryCacheCounterexampleCovered([{ ...warm, partialMatchesCold: false }])).toBe(false);
    expect(queryCacheCounterexampleCovered([{ partialMatchesCold: false, cache: { partial: { queryHits: 0, queryMisses: 60 } } }])).toBe(false);
    expect(queryCacheCounterexampleCovered([{ partialMatchesCold: true, cache: { partial: { queryHits: 36, queryMisses: 24 } } }])).toBe(false);
    expect(queryCacheCounterexampleCovered([warm, { partialMatchesCold: false, cache: { partial: { queryHits: 36, queryMisses: 24 } } }])).toBe(true);
  });
});
