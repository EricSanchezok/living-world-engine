import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectFullPrecisionEncoder } from "./encoder-graph";
import { localEncoderFingerprint, type LocalEncoderRuntime } from "./local-encoder";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function graph(op: string, type: number) {
  const loader = createRequire(import.meta.url);
  const schema = loader(path.resolve("node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js")) as {
    onnx: { ModelProto: { encode(value: unknown): { finish(): Uint8Array } } };
  };
  const bytes = schema.onnx.ModelProto.encode({ producerName: "test", graph: {
    node: [{ opType: op }], initializer: [{ name: "weight", dataType: type, dims: [1], floatData: [1] }],
  } }).finish();
  const root = mkdtempSync(path.join(os.tmpdir(), "encoder-graph-"));
  roots.push(root);
  const file = path.join(root, "model.onnx");
  writeFileSync(file, bytes);
  return { file, sha: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}
it("checks actual graph types and quantization operators rather than an fp32 loader string", () => {
  const full = graph("MatMul", 1);
  expect(inspectFullPrecisionEncoder(full.file, full.sha).initializerTypes).toEqual({ 1: 1 });
  const dynamic = graph("DynamicQuantizeLinear", 1);
  expect(() => inspectFullPrecisionEncoder(dynamic.file, dynamic.sha)).toThrow("quantization");
  const half = graph("MatMul", 10);
  expect(() => inspectFullPrecisionEncoder(half.file, half.sha)).toThrow("non-fp32");
  expect(() => inspectFullPrecisionEncoder(full.file, half.sha)).toThrow("hash drift");
});
it("separates explicit tokenization cache fingerprints without rewriting legacy fingerprints", () => {
  const legacy: LocalEncoderRuntime = { modelId: "fixture", modelHash: "sha256:" + "1".repeat(64),
    dimensions: 1, encodeBatch: async () => [[1]] };
  const first = localEncoderFingerprint(legacy, 1);
  expect(localEncoderFingerprint({ ...legacy }, 1)).toBe(first);
  expect(localEncoderFingerprint({ ...legacy, inferenceContract: "explicit-fp32-128-v2" }, 1)).not.toBe(first);
});
