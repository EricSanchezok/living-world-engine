import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CachedQueryEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { FULL_TEXT_WINDOW_CONTRACT } from "../../src/engine/benchmarks/step-efficiency/full-text-window-encoder";
import { loadFullTextWindowNative, type FullTextEncodingTrace } from "./full-text-window-native";

interface TraceFile { trace: Array<{ queries: string[] }> }
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const implementationFiles = ["scripts/experiments/verify-full-text-window-encoder.ts", "scripts/experiments/full-text-window-native.ts", "scripts/experiments/verify-semantic-first-pass-encoder.ts",
  "src/engine/benchmarks/step-efficiency/full-text-window-encoder.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/encoder-graph.ts"];

export async function verifyFullTextWindowEncoder(sourceRoot: string, modelDirectory: string, outputRoot: string) {
  const codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("native comparison requires a clean committed producer");
  const sourceManifestFile = path.join(sourceRoot, "manifest.json");
  const sourceManifest = read<{ protocol: string; actionIds: string[][] }>(sourceManifestFile);
  const sourceResult = read<{ passed: boolean; counterexampleCovered: boolean }>(path.join(sourceRoot, "result.json"));
  if (sourceManifest.protocol !== "complete-query-batch-cache-v2" || !sourceResult.passed || !sourceResult.counterexampleCovered
    || sourceManifest.actionIds.length !== 5 || sourceManifest.actionIds.flat().length !== 49
    || new Set(sourceManifest.actionIds.flat()).size !== 49) throw new Error("source lacks the complete qualified 49-action query cohort");
  const sourceFiles = sourceManifest.actionIds.map((actions, index) => {
    const files = { B: path.join(sourceRoot, `source-${index}-cold.json`), C: path.join(sourceRoot, `source-${index}-partial-prime.json`) };
    const traces = { B: read<TraceFile>(files.B).trace, C: read<TraceFile>(files.C).trace };
    if (traces.B.length !== 1 || traces.C.length !== 1 || traces.B[0]!.queries.length !== actions.length * 5
      || traces.C[0]!.queries.length !== actions.length * 5) throw new Error("incomplete physical query batch");
    return { files, B: traces.B[0]!.queries, C: traces.C[0]!.queries };
  });
  let calls: FullTextEncodingTrace[] = [];
  const native = await loadFullTextWindowNative(modelDirectory, call => { calls.push(call); });
  const { encoder, identity: { graph, modelHash, libraries, libraryEntries } } = native;
  mkdirSync(outputRoot, { recursive: false });
  const save = (name: string, value: unknown) => writeFileSync(path.join(outputRoot, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  save("manifest", { protocol: "full-text-window-encoder-v1", codeRevision, contract: FULL_TEXT_WINDOW_CONTRACT,
    graph, modelHash, libraries, libraryEntries, sourceManifestSha256: hash(sourceManifestFile), actionIds: sourceManifest.actionIds,
    sources: sourceFiles.map(source => ({ B: hash(source.files.B), C: hash(source.files.C) })),
    implementationHashes: Object.fromEntries(implementationFiles.map(file => [file, hash(file)])), newModelHttp: 0,
    passageWrites: false, retrievalQualification: false, fullPlayerQualification: false });
  const rows = [];
  try {
    for (const [index, source] of sourceFiles.entries()) {
      calls = [];
      const coldStart = performance.now();
      const cold = await new CachedQueryEncoder(encoder).encodeBatch(source.B);
      const coldMs = performance.now() - coldStart;
      save(`source-${index}-cold`, { query: source.B, result: cold, calls });
      calls = [];
      const partialCache = new CachedQueryEncoder(encoder);
      const prime = await partialCache.encodeBatch(source.C);
      save(`source-${index}-prime`, { query: source.C, result: prime, calls });
      calls = [];
      const partialStart = performance.now(), partial = await partialCache.encodeBatch(source.B), partialMs = performance.now() - partialStart;
      save(`source-${index}-partial`, { query: source.B, result: partial, calls });
      const warmStart = performance.now(), warm = await partialCache.encodeBatch(source.B), warmMs = performance.now() - warmStart;
      calls = [];
      const reverse = await new CachedQueryEncoder(encoder).encodeBatch([...source.B].reverse());
      save(`source-${index}-reverse`, { result: reverse, calls });
      const difference = (actual: readonly (readonly number[])[]) => {
        let maxDelta = 0, changedVectors = 0;
        cold.vectors.forEach((vector, row) => {
          let changed = false;
          vector.forEach((value, column) => { const delta = Math.abs(value - actual[row]![column]!); maxDelta = Math.max(maxDelta, delta); changed ||= delta !== 0; });
          changedVectors += Number(changed);
        });
        return { maxDelta, changedVectors };
      };
      const row = { index, queryCount: source.B.length, hits: partial.hits, misses: partial.misses,
        partial: difference(partial.vectors), reverse: difference([...reverse.vectors].reverse()), warm: difference(warm.vectors), coldMs, partialMs, warmMs };
      rows.push(row);
      save(`source-${index}-summary`, row);
      process.stdout.write(JSON.stringify(row) + "\n");
    }
    const result = { passed: rows.every(row => row.hits > 0 && row.misses > 0 && row.partial.maxDelta === 0 && row.reverse.maxDelta === 0 && row.warm.maxDelta === 0),
      rows, newModelHttp: 0, retrievalQualification: false, fullPlayerQualification: false };
    save("result", result);
    return result;
  } finally { await native.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  globalThis.fetch = async () => { throw new Error("offline full-text verification forbids HTTP"); };
  const args = process.argv.slice(2);
  if (args.length !== 3) throw new Error("usage: verify-full-text-window-encoder <complete-cache-source> <fp32-model-directory> <new-output-root>");
  verifyFullTextWindowEncoder(...args.map(value => path.resolve(value)) as [string, string, string]).then(result => {
    process.stdout.write(JSON.stringify({ passed: result.passed, newModelHttp: 0 }) + "\n");
    if (!result.passed) process.exitCode = 1;
  }).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
