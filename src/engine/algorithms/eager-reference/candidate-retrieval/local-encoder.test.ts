import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  CachedQueryEncoder,
  resolveInstalledModule,
  TRANSFORMERS_LIBRARY_PACKAGE,
  type LocalEncoderRuntime,
} from "./local-encoder";

describe("server runtime module resolution", () => {
  it("resolves external encoder dependencies through the native runtime resolver", () => {
    const transformers = resolveInstalledModule(TRANSFORMERS_LIBRARY_PACKAGE);
    const onnxRuntime = resolveInstalledModule("onnxruntime-node/package.json");

    expect(path.isAbsolute(transformers)).toBe(true);
    expect(transformers).toContain(path.join("node_modules", "@huggingface", "transformers"));
    expect(path.isAbsolute(onnxRuntime)).toBe(true);
    expect(onnxRuntime).toContain(path.join("node_modules", "onnxruntime-node"));
  });
});

describe("dynamic query encoder cache", () => {
  it("single-flights exact queries and evicts least-recently-used entries", async () => {
    let calls = 0;
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"1".repeat(64)}`,
      dimensions: 2,
      async encodeBatch(texts) {
        calls += 1;
        return texts.map((text) => [text.length, calls]);
      },
    };
    const cache = new CachedQueryEncoder(encoder, 2);
    const [first, concurrent] = await Promise.all([cache.encode("one"), cache.encode("one")]);
    expect(first.vector).toEqual(concurrent.vector);
    expect(first.cacheHit).toBe(false);
    expect(concurrent.cacheHit).toBe(true);
    expect(calls).toBe(1);

    expect((await cache.encode("one")).cacheHit).toBe(true);
    await cache.encode("two");
    await cache.encode("three");
    expect(cache.size).toBe(2);
    expect((await cache.encode("one")).cacheHit).toBe(false);
    expect(calls).toBe(4);
  });

  it("rejects non-finite query vectors", async () => {
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"1".repeat(64)}`,
      dimensions: 2,
      async encodeBatch() { return [[Number.NaN, 1]]; },
    };
    await expect(new CachedQueryEncoder(encoder).encode("bad")).rejects.toThrow("non-finite");
  });

  it("batches only misses, skips the encoder on full hits, and shares concurrent work", async () => {
    const calls: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"2".repeat(64)}`,
      dimensions: 2,
      async encodeBatch(texts) {
        calls.push([...texts]);
        if (texts.some((text) => text.includes("shared"))) await gate;
        return texts.map((text) => [text.length, 1]);
      },
    };
    const cache = new CachedQueryEncoder(encoder, 8);

    const cold = await cache.encodeBatch(["one", "two", "one"]);
    expect(cold).toMatchObject({ hits: 0, misses: 2, encoded: 2 });
    expect(cold.vectors[0]).toBe(cold.vectors[2]);
    expect(calls).toHaveLength(1);

    const partial = await cache.encodeBatch(["two", "three"]);
    expect(partial).toMatchObject({ hits: 1, misses: 1, encoded: 1 });
    expect(calls[1]).toEqual(["query: three"]);

    const hit = await cache.encodeBatch(["one", "three"]);
    expect(hit).toMatchObject({ hits: 2, misses: 0, encoded: 0 });
    expect(calls).toHaveLength(2);

    const owner = cache.encodeBatch(["shared", "four"]);
    const follower = cache.encodeBatch(["shared"]);
    release();
    const [owned, followed] = await Promise.all([owner, follower]);
    expect(owned).toMatchObject({ hits: 0, misses: 2, encoded: 2 });
    expect(followed).toMatchObject({ hits: 1, misses: 0, encoded: 0 });
    expect(owned.vectors[0]).toEqual(followed.vectors[0]);
    expect(calls).toHaveLength(3);
  });
});
