import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { inspectFullPrecisionEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/encoder-graph";
import { CachedQueryEncoder, loadLocalEncoder, localEncoderFingerprint } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { createRelationalRrfPhysicalBatchRetriever } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { createCoverageAwareJointBudgetSelector } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import { createActionCompilationRetrievalRuntime } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import { readConstrainedFirstPassSources } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-sources";
import { immutableExperimentJson } from "../../src/engine/benchmarks/action-compilation/experiment-artifacts";
import { AC_FP3_PROTOCOL } from "../../src/engine/benchmarks/action-compilation/semantic-first-pass-protocol";

export const FP32_E5_SOURCE = {
  modelId: "intfloat/multilingual-e5-base",
  source: "https://huggingface.co/Xenova/multilingual-e5-base/blob/d59ab9ac3405fabf723089ec5577010211014c99/onnx/model.onnx",
  sha256: "sha256:84a4d426f7e87a6bf5bf195f0bae2c4a7d15f675b23ca96f42fab8326d7a77aa",
} as const;

export async function verifySemanticFirstPassEncoder(root = path.resolve(AC_FP3_PROTOCOL.root)) {
  const directory = path.join(root, "assets/e5-base-fp32");
  const graph = inspectFullPrecisionEncoder(path.join(directory, "onnx/model.onnx"), FP32_E5_SOURCE.sha256);
  const encoder = await loadLocalEncoder({ modelDirectory: directory, modelId: FP32_E5_SOURCE.modelId,
    explicitFp32OnnxSha256: FP32_E5_SOURCE.sha256 });
  const fingerprint = localEncoderFingerprint(encoder, 1);
  const passageEncoder = new CachedPassageEncoder(encoder, fingerprint, path.join(root, "encoder-cache"));
  const sources = readConstrainedFirstPassSources(path.resolve(".livingworld-benchmarks/experiments/ac-fp1/v1")).sources;
  class TracingQueries extends CachedQueryEncoder {
    queries: readonly string[] = [];
    vectors: readonly (readonly number[])[] = [];
    override async encodeBatch(queries: readonly string[]) {
      const value = await super.encodeBatch(queries);
      this.queries = [...queries]; this.vectors = value.vectors;
      return value;
    }
  }
  const make = () => {
    const query = new TracingQueries(encoder);
    const runtime = createActionCompilationRetrievalRuntime({ version: "ac-fp3-explicit-encoder-validation-v1", budgetRatio: .2,
      selectBatch: createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: .15 }),
      retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({ encoder, passageEncoder, queryEncoder: query,
        maxPathDepth: 3, pseudoSeedCount: 16, allowPassageWrites: true }) });
    return { query, runtime };
  };
  const rows = [];
  try {
    for (const [sourceIndex, source] of sources.entries()) {
      const input = { worldContentHash: source.worldHash, fullContext: source.fullContext, slotIndices: source.actions.map((_, index) => index) };
      const baseline = make();
      process.stdout.write("ENCODER source " + (sourceIndex + 1) + " cold retrieval\n");
      const cold = await baseline.runtime.retrieveBatch(input);
      const queries = baseline.query.queries, vectors = baseline.query.vectors;
      for (const variant of ["warm-all", "first-1", "first-15", "first-30", "first-45", "first-59", "reverse-all", "other-co-batch"] as const) {
        const test = variant === "warm-all" ? baseline : make();
        if (variant.startsWith("first-")) await test.query.encodeBatch(queries.slice(0, Number(variant.slice(6))));
        if (variant === "reverse-all") await test.query.encodeBatch([...queries].reverse());
        if (variant === "other-co-batch") await test.query.encodeBatch([...queries.slice(0, 15),
          ...Array.from({ length: 45 }, (_, index) => "unrelated co-batch text " + index)]);
        const actual = await test.runtime.retrieveBatch(input);
        const maxVectorDelta = Math.max(0, ...vectors.flatMap((vector, index) => vector.map((value, column) => Math.abs(value - test.query.vectors[index]![column]!))));
        const row = { sourceIndex, sourceHash: contentHash(source), variant, fingerprint,
          queryCount: queries.length, queryInputsMatch: contentHash(queries) === contentHash(test.query.queries),
          contextMatches: actual.modelContextHash === cold.modelContextHash, shortlistMatches: actual.shortlistHash === cold.shortlistHash,
          maxVectorDelta, contextHash: actual.modelContextHash, shortlistHash: actual.shortlistHash, cache: actual.diagnostics.cache };
        rows.push(row);
        immutableExperimentJson(path.join(root, "encoder-verification", contentHash(row) + ".json"), row);
        process.stdout.write(JSON.stringify({ sourceIndex, variant, passed: row.contextMatches && row.shortlistMatches, maxVectorDelta }) + "\n");
      }
    }
    const result = { passed: rows.every((row) => row.queryInputsMatch && row.contextMatches && row.shortlistMatches),
      source: FP32_E5_SOURCE, graph, modelDirectoryHash: encoder.modelHash, inferenceContract: encoder.inferenceContract,
      fingerprint, rows, providerHttp: 0, cacheRoot: path.join(root, "encoder-cache"),
      implementationHashes: ["src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts",
        "src/engine/algorithms/eager-reference/candidate-retrieval/encoder-graph.ts",
        "scripts/experiments/verify-semantic-first-pass-encoder.ts"].map((file) => ({ file, hash: contentHash(readFileSync(file, "utf8")) })),
      claimBoundary: "Cache/co-batch invariance on four existing source batches; not retrieval-quality, semantic, or compiler-success improvement." };
    const file = path.join(root, "encoder-verification", contentHash(result) + ".json");
    immutableExperimentJson(file, result);
    return { passed: result.passed, file, fingerprint };
  } finally { passageEncoder.close(); await encoder.dispose?.(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  globalThis.fetch = async () => { throw new Error("offline encoder verification forbids HTTP"); };
  verifySemanticFirstPassEncoder().then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.passed) process.exitCode = 1;
  }).catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
