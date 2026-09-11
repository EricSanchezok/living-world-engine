import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashLocalModelDirectory, loadLocalEncoder } from "../../../algorithms/eager-reference/candidate-retrieval/local-encoder";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local multilingual-e5-small asset handling", () => {
  it("hashes model files deterministically and detects content changes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lwe-e5-fixture-"));
    temporaryDirectories.push(directory);
    writeFileSync(path.join(directory, "tokenizer.json"), "tokenizer-v1\n", "utf8");
    writeFileSync(path.join(directory, "model.onnx"), "weights-v1\n", "utf8");
    const first = hashLocalModelDirectory(directory);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashLocalModelDirectory(directory)).toBe(first);
    writeFileSync(path.join(directory, "model.onnx"), "weights-v2\n", "utf8");
    expect(hashLocalModelDirectory(directory)).not.toBe(first);
  });

  it("excludes mutable downloader metadata from the model identity", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "lwe-e5-cache-fixture-"));
    temporaryDirectories.push(directory);
    writeFileSync(path.join(directory, "model.onnx"), "weights\n", "utf8");
    const first = hashLocalModelDirectory(directory);
    writeFileSync(path.join(directory, ".cache-marker"), "not a cache directory\n", "utf8");
    const second = hashLocalModelDirectory(directory);
    expect(second).not.toBe(first);
    const cache = path.join(directory, ".cache");
    mkdirSync(cache);
    writeFileSync(path.join(cache, "download.metadata"), "mutable\n", "utf8");
    expect(hashLocalModelDirectory(directory)).toBe(second);
  });

  it("fails closed when the local model directory is missing", async () => {
    await expect(loadLocalEncoder({ modelDirectory: "/tmp/lwe-model-does-not-exist" }))
      .rejects.toThrow(/model directory is missing/u);
  });
});
