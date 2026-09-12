import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { CompleteQueryBatchCache } from "../../src/engine/benchmarks/step-efficiency/complete-query-batch-cache";
import { CachedQueryEncoder, discoverLocalEncoderModelDirectory, livingWorldCacheRoot, loadLocalEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { createRelationalRrfPhysicalBatchRetriever, relationalRrfEncoderFingerprint, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { createCoverageAwareJointBudgetSelector } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import { createActionCompilationRetrievalRuntime, ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import type { CandidateSelectionCapability, CandidateSelectionResult } from "../../src/engine/algorithms/roles";

type RetrievalRequest = Parameters<CandidateSelectionCapability["retrieveBatch"]>[0];
type RecordedRetrieval = { request: RetrievalRequest; selected: { modelContextHash: string; shortlistHash: string } };
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sourceFiles = ["scripts/experiments/verify-query-batch-cache.ts", "src/engine/benchmarks/step-efficiency/complete-query-batch-cache.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/encoder-worker.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/runtime.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget.ts"];

function equalSelection(a: CandidateSelectionResult, b: { modelContextHash: string; shortlistHash: string }): boolean {
  return a.modelContextHash === b.modelContextHash && a.shortlistHash === b.shortlistHash;
}

export async function verifyQueryBatchCache(sourceRoot: string, outputRoot: string) {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked diagnostic before native comparison");
  const manifestFile = path.join(sourceRoot, "manifest.json");
  const manifest = read<{ binding: { protocol: { id: string } } }>(manifestFile);
  const terminal = read<{ complete: boolean; totalHttp: number }>(path.join(sourceRoot, "preflight/terminal.json"));
  if (manifest.binding.protocol.id !== "adjudicated-objective-compilation-v1" || !terminal.complete || terminal.totalHttp !== 0) throw new Error("Complete frozen objective preflight required");
  const originals = read<Array<{ actionIds: string[] }>>(path.join(sourceRoot, "preflight/sources.json"));
  if (JSON.stringify(originals.map(source => source.actionIds.length)) !== JSON.stringify([12, 12, 12, 5, 8]) ||
    new Set(originals.flatMap(source => source.actionIds)).size !== 49) throw new Error("Complete original 49-action cohort required");
  const files = originals.map((_, index) => Object.fromEntries(["B", "C"].map(arm =>
    [arm, path.join(sourceRoot, `preflight/source-${index}-${arm}/retrieval-1.json`)])) as Record<"B" | "C", string>);
  const sources = files.map(pair => ({ B: read<RecordedRetrieval>(pair.B), C: read<RecordedRetrieval>(pair.C) }));
  const cacheRoot = livingWorldCacheRoot();
  mkdirSync(outputRoot, { recursive: false });
  const save = (file: string, value: unknown) => writeFileSync(path.join(outputRoot, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  save("manifest.json", { protocol: "complete-query-batch-cache-v1", codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceRoot, sourceManifestSha256: fileHash(manifestFile), sourceSha256: files.map(pair => ({ B: fileHash(pair.B), C: fileHash(pair.C) })),
    implementationHashes: Object.fromEntries(sourceFiles.map(file => [file, fileHash(file)])), actionIds: originals.map(source => source.actionIds),
    comparisons: ["cold B", "per-query C then B", "complete-batch C then B", "complete-batch repeated B"],
    newHttp: 0, passageWrites: false, fullPlayerAcceptance: false });
  const encoder = await loadLocalEncoder({ modelDirectory: discoverLocalEncoderModelDirectory(cacheRoot, MULTILINGUAL_E5_BASE_ASSET.name),
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256 });
  const fingerprint = relationalRrfEncoderFingerprint(encoder, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION);
  const passages = new CachedPassageEncoder(encoder, fingerprint, cacheRoot);
  const traces = new Map<CachedQueryEncoder, Array<{ queries: readonly string[]; vectors: readonly (readonly number[])[]; hits: number; misses: number }>>();
  const runtime = (query: CachedQueryEncoder) => {
    const entries: Array<{ queries: readonly string[]; vectors: readonly (readonly number[])[]; hits: number; misses: number }> = [];
    traces.set(query, entries);
    const encode = query.encodeBatch.bind(query);
    query.encodeBatch = async queries => {
      const result = await encode(queries);
      entries.push({ queries: [...queries], ...result });
      return result;
    };
    return createActionCompilationRetrievalRuntime({ version: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION, budgetRatio: .2,
      selectBatch: createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: .15 }),
      retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({ encoder, passageEncoder: passages, queryEncoder: query,
        maxPathDepth: 3, pseudoSeedCount: 16, allowPassageWrites: false }) });
  };
  const retain = (label: string, result: CandidateSelectionResult, query: CachedQueryEncoder) => {
    save(`${label}.json`, { selected: { ...result, selectedKeysBySlot: Object.fromEntries(result.selectedKeysBySlot) }, trace: traces.get(query) });
  };
  const rows = [], started = performance.now();
  try {
    for (const [index, source] of sources.entries()) {
      const coldQuery = new CachedQueryEncoder(encoder), cold = await runtime(coldQuery).retrieveBatch(source.B.request);
      retain(`source-${index}-cold`, cold, coldQuery);
      if (!equalSelection(cold, source.B.selected)) throw new Error(`Source ${index} cold retrieval drift`);
      const partialQuery = new CachedQueryEncoder(encoder), partialRuntime = runtime(partialQuery);
      const partialPrime = await partialRuntime.retrieveBatch(source.C.request);
      retain(`source-${index}-partial-prime`, partialPrime, partialQuery);
      if (!equalSelection(partialPrime, source.C.selected)) throw new Error(`Source ${index} C retrieval drift`);
      const partial = await partialRuntime.retrieveBatch(source.B.request);
      retain(`source-${index}-partial`, partial, partialQuery);
      const completeQuery = new CompleteQueryBatchCache(encoder), completeRuntime = runtime(completeQuery);
      const completePrime = await completeRuntime.retrieveBatch(source.C.request);
      retain(`source-${index}-complete-prime`, completePrime, completeQuery);
      if (!equalSelection(completePrime, source.C.selected)) throw new Error(`Source ${index} candidate C retrieval drift`);
      const complete = await completeRuntime.retrieveBatch(source.B.request);
      retain(`source-${index}-complete`, complete, completeQuery);
      const warm = await completeRuntime.retrieveBatch(source.B.request);
      retain(`source-${index}-warm`, warm, completeQuery);
      const originalTrace = traces.get(coldQuery)![0]!;
      const vectorComparison = (query: CachedQueryEncoder, position: number) => {
        const actual = traces.get(query)![position]!;
        if (JSON.stringify(actual.queries) !== JSON.stringify(originalTrace.queries)) throw new Error("Original query strings changed");
        let maxAbs = 0, changed = 0;
        actual.vectors.forEach((vector, row) => {
          let unequal = false;
          vector.forEach((value, col) => { const delta = Math.abs(value - originalTrace.vectors[row]![col]!); maxAbs = Math.max(maxAbs, delta); unequal ||= delta !== 0; });
          if (unequal) changed += 1;
        });
        return { changed, maxAbs };
      };
      const partialVectors = vectorComparison(partialQuery, 1), completeVectors = vectorComparison(completeQuery, 1);
      const row = { sourceIndex: index, actions: originals[index]!.actionIds.length, requestHashes: { B: contentHash(source.B.request), C: contentHash(source.C.request) },
        coldMatchesRecorded: true, partialMatchesCold: equalSelection(partial, cold), completeMatchesCold: equalSelection(complete, cold),
        warmMatchesCold: equalSelection(warm, cold), partialVectors, completeVectors,
        cache: { cold: cold.diagnostics.cache, partial: partial.diagnostics.cache, complete: complete.diagnostics.cache, warm: warm.diagnostics.cache } };
      rows.push(row);
      save(`source-${index}-summary.json`, row);
      process.stdout.write(JSON.stringify(row) + "\n");
    }
    const result = { complete: true, passed: rows.every(row => row.completeMatchesCold && row.warmMatchesCold && row.completeVectors.changed === 0 && row.cache.warm?.queryMisses === 0),
      newHttp: 0, rows, elapsedMs: performance.now() - started, fingerprint,
      limitation: "Query-cache equivalence with frozen passages on five full batches; not passage generation invariance, retrieval quality, model success or player latency." };
    save("result.json", result);
    return result;
  } catch (error) {
    save("failure.json", { error: error instanceof Error ? error.message : String(error), rows, newHttp: 0 });
    throw error;
  } finally { passages.close(); await encoder.dispose?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  globalThis.fetch = async () => { throw new Error("Offline retrieval diagnostic forbids HTTP"); };
  if (process.argv.length !== 4) throw new Error("usage: verify-query-batch-cache.ts <objective-preflight-root> <new-output-root>");
  void verifyQueryBatchCache(path.resolve(process.argv[2]!), path.resolve(process.argv[3]!)).then(result => {
    process.stdout.write(JSON.stringify({ complete: result.complete, passed: result.passed, rows: result.rows.length, newHttp: 0 }) + "\n");
    if (!result.passed) process.exitCode = 1;
  }).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
