import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { inspectFullPrecisionEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/encoder-graph";
import { hashLocalModelDirectory, resolveInstalledModule } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { encodeFullTextWindows, FULL_TEXT_WINDOW_CONTRACT, type TokenizedEncoderText, type EncoderTokenWindow } from "../../src/engine/benchmarks/step-efficiency/full-text-window-encoder";
import { FP32_E5_SOURCE } from "./verify-semantic-first-pass-encoder";

interface NativeTensor {
  dims: number[];
  data: Float32Array;
  normalize(p: number, dimension: number): NativeTensor;
  tolist(): number[][];
}
interface NativeTokenizer {
  (text: string, options: Record<string, unknown>): { input_ids: number[] };
  pad_token_id: number;
}
interface NativeModule {
  env: { allowRemoteModels: boolean; allowLocalModels: boolean };
  Tensor: new (kind: string, data: BigInt64Array, dims: number[]) => NativeTensor;
  mean_pooling(output: NativeTensor, mask: NativeTensor): NativeTensor;
  pipeline(task: string, model: string, options: Record<string, unknown>): Promise<{
    tokenizer: NativeTokenizer;
    model(inputs: Record<string, NativeTensor>): Promise<{ last_hidden_state: NativeTensor }>;
    dispose(): Promise<void>;
  }>;
}

export interface FullTextEncodingTrace {
  texts: readonly string[];
  tokenized: TokenizedEncoderText[];
  vectors: number[][];
  plans: EncoderTokenWindow[][];
  shapes: number[][];
  elapsedMs: number;
}
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const FULL_TEXT_NATIVE_IMPLEMENTATION_FILES = ["scripts/experiments/full-text-window-native.ts",
  "src/engine/benchmarks/step-efficiency/full-text-window-encoder.ts"];

export async function loadFullTextWindowNative(modelDirectory: string, observe?: (call: FullTextEncodingTrace) => void) {
  const graph = inspectFullPrecisionEncoder(path.join(modelDirectory, "onnx/model.onnx"), FP32_E5_SOURCE.sha256);
  const modelHash = hashLocalModelDirectory(modelDirectory);
  const libraryEntries = ["@huggingface/transformers", "onnxruntime-node/package.json"].map(name => {
    const entry = resolveInstalledModule(name);
    return { name, entrySha256: hash(entry) };
  });
  const transformersEntry = resolveInstalledModule("@huggingface/transformers");
  const transformersRoot = path.dirname(path.dirname(transformersEntry));
  const runtimePackage = resolveInstalledModule("onnxruntime-node/package.json");
  const libraries = { transformersVersion: read<{ version: string }>(path.join(transformersRoot, "package.json")).version,
    transformersHash: hashLocalModelDirectory(transformersRoot), onnxVersion: read<{ version: string }>(runtimePackage).version,
    onnxHash: hashLocalModelDirectory(path.dirname(runtimePackage)), node: process.version, platform: process.platform, arch: process.arch };
  const native = await import(pathToFileURL(transformersEntry).href) as NativeModule;
  native.env.allowRemoteModels = false;
  native.env.allowLocalModels = true;
  const extractor = await native.pipeline("feature-extraction", modelDirectory, { device: "cpu", dtype: "fp32", local_files_only: true });
  const tokenIds = (text: string, special: boolean) => extractor.tokenizer(text,
    { add_special_tokens: special, padding: false, truncation: false, return_tensor: false }).input_ids;
  const empty = tokenIds("", true);
  if (empty.length !== 2) throw new Error("unexpected E5 boundary tokens");
  const prefixes = { "query: ": tokenIds("query: ", false), "passage: ": tokenIds("passage: ", false) };
  const tokenize = (text: string): TokenizedEncoderText => {
    const prefix = Object.keys(prefixes).find(value => text.startsWith(value)) as keyof typeof prefixes | undefined;
    if (!prefix) throw new Error("missing E5 query/passage prefix");
    return { tokenIds: tokenIds(text, true), prefixIds: prefixes[prefix], bos: empty[0]!, eos: empty[1]!, pad: extractor.tokenizer.pad_token_id };
  };
  const encoder = { modelId: FP32_E5_SOURCE.modelId, modelHash, dimensions: 768,
    async encodeBatch(texts: readonly string[]) {
      const started = performance.now(), tokenized = texts.map(tokenize), shapes: number[][] = [];
      const output = await encodeFullTextWindows(tokenized, async windows => {
        const width = windows[0]!.width, shape = [windows.length, width];
        shapes.push(shape);
        const input = new native.Tensor("int64", BigInt64Array.from(windows.flatMap(window => window.inputIds), BigInt), shape);
        const mask = new native.Tensor("int64", BigInt64Array.from(windows.flatMap(window => window.attentionMask), BigInt), shape);
        const raw = await extractor.model({ input_ids: input, attention_mask: mask });
        const pooled = native.mean_pooling(raw.last_hidden_state, mask).normalize(2, -1);
        if (!(pooled.data instanceof Float32Array) || pooled.dims.length !== 2 || pooled.dims[0] !== windows.length || pooled.dims[1] !== 768) {
          throw new Error("native window output contract mismatch");
        }
        return pooled.tolist();
      }, 768);
      const elapsedMs = performance.now() - started;
      observe?.({ texts, tokenized, ...output, shapes, elapsedMs });
      return output.vectors;
    } };
  const identity = { modelId: encoder.modelId, modelHash, dimensions: encoder.dimensions, graph, libraries, libraryEntries,
    contract: FULL_TEXT_WINDOW_CONTRACT, passageSchemaVersion: 1,
    implementationHashes: Object.fromEntries(FULL_TEXT_NATIVE_IMPLEMENTATION_FILES.map(file => [file, hash(file)])) };
  return { encoder, identity, fingerprint: `sha256:${contentHash(identity)}`,
    dispose: () => extractor.dispose() };
}
