import { describe, expect, it } from "vitest";
import { CachedQueryEncoder, type LocalEncoderRuntime } from "../../algorithms/eager-reference/candidate-retrieval/local-encoder";
import { CompleteQueryBatchCache } from "./complete-query-batch-cache";

function fixture() {
  const calls: string[][] = [];
  const vectors = (texts: readonly string[]) => texts.map(text => [text.length, texts.reduce((sum, entry, index) => sum + entry.length * (index + 1), 0)]);
  const encoder: LocalEncoderRuntime = { modelId: "batch-dependent", modelHash: "fixture", dimensions: 2,
    async encodeBatch(texts) { calls.push([...texts]); return vectors(texts); } };
  return { encoder, calls, vectors };
}

describe("complete query batch memoization", () => {
  it("preserves cold vectors through partial overlap and changed order while retaining exact warm reuse", async () => {
    const { encoder, calls, vectors } = fixture();
    const old = new CachedQueryEncoder(encoder), candidate = new CompleteQueryBatchCache(encoder);
    for (const cache of [old, candidate]) await cache.encodeBatch(["shared", "first"]);
    const wanted = vectors(["query: shared", "query: second"]);
    expect((await old.encodeBatch(["shared", "second"])).vectors).not.toEqual(wanted);
    expect(await candidate.encodeBatch(["shared", "second", "shared"])).toEqual({ vectors: [wanted[0], wanted[1], wanted[0]], hits: 0, misses: 2, encoded: 2 });
    const count = calls.length;
    expect(await candidate.encodeBatch(["shared", "second"])).toMatchObject({ vectors: wanted, hits: 2, encoded: 0 });
    expect(calls).toHaveLength(count);
    expect((await candidate.encodeBatch(["second", "shared"])).vectors).toEqual(vectors(["query: second", "query: shared"]));
    expect(calls).toHaveLength(count + 1);
  });

  it("shares complete in-flight batches, bounds retained vectors and never stores invalid results", async () => {
    const { encoder, calls } = fixture();
    const candidate = new CompleteQueryBatchCache(encoder, 3);
    const [first, shared] = await Promise.all([candidate.encodeBatch(["a", "b"]), candidate.encodeBatch(["a", "b", "a"])]);
    expect(calls).toHaveLength(1);
    expect(first).toMatchObject({ hits: 0, misses: 2 });
    expect(shared).toMatchObject({ hits: 2, misses: 0 });
    expect(shared.vectors[0]).toBe(first.vectors[0]);
    expect(Object.isFrozen(first.vectors[0])).toBe(true);
    await candidate.encodeBatch(["c"]);
    await candidate.encodeBatch(["a", "b"]);
    await candidate.encodeBatch(["d"]);
    expect(candidate.size).toBe(3);
    expect((await candidate.encodeBatch(["c"])).misses).toBe(1);
    const oversized = ["w", "x", "y", "z"];
    await candidate.encodeBatch(oversized);
    expect((await candidate.encodeBatch(oversized)).misses).toBe(4);
    expect(candidate.size).toBeLessThanOrEqual(3);
    const beforeEmpty = calls.length;
    expect(await candidate.encodeBatch([])).toEqual({ vectors: [], hits: 0, misses: 0, encoded: 0 });
    expect(calls).toHaveLength(beforeEmpty);

    let invalid = true;
    const checked = new CompleteQueryBatchCache({ ...encoder, async encodeBatch(texts) {
      return invalid ? [[Number.NaN, 0]] : encoder.encodeBatch(texts);
    } });
    const failed = await Promise.allSettled([checked.encodeBatch(["a"]), checked.encodeBatch(["a"])]);
    expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(checked.size).toBe(0);
    invalid = false;
    expect((await checked.encodeBatch(["a"])).misses).toBe(1);
    await expect(new CompleteQueryBatchCache({ ...encoder, async encodeBatch() { return []; } }).encodeBatch(["a"])).rejects.toThrow("count");
  });
});
