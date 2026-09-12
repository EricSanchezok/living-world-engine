import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { CachedQueryEncoder, type QueryBatchEncodingResult } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { createRelationalRrfPhysicalBatchRetriever, r5RelationalPassagesForContext } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { createActionCompilationRetrievalRuntime, ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import { createCoverageAwareJointBudgetSelector } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import type { CandidateSelectionCapability, CandidateSelectionResult } from "../../src/engine/algorithms/roles";
import { FULL_TEXT_NATIVE_IMPLEMENTATION_FILES, loadFullTextWindowNative } from "./full-text-window-native";

type Request = Parameters<CandidateSelectionCapability["retrieveBatch"]>[0];
type RecordedSource = { request: Request; selected: { modelContextHash: string; shortlistHash: string } };
type StoredSelection = Omit<CandidateSelectionResult, "selectedKeysBySlot"> & { selectedKeysBySlot: Record<string, string[]> };
const read = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const implementationFiles = [...FULL_TEXT_NATIVE_IMPLEMENTATION_FILES, "scripts/experiments/verify-full-text-window-retrieval.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/runtime.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget.ts", "src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache.ts",
  "src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts"];

function vectorDifference(expected: readonly (readonly number[])[], actual: readonly (readonly number[])[]) {
  if (expected.length !== actual.length) throw new Error("vector comparison cardinality mismatch");
  let maxDelta = 0, changedVectors = 0;
  expected.forEach((vector, index) => {
    if (vector.length !== actual[index]!.length) throw new Error("vector comparison dimension mismatch");
    let changed = false;
    vector.forEach((value, column) => {
      const delta = Math.abs(value - actual[index]![column]!);
      if (!Number.isFinite(delta)) throw new Error("vector comparison is not finite");
      maxDelta = Math.max(maxDelta, delta);
      changed ||= delta !== 0;
    });
    changedVectors += Number(changed);
  });
  return { maxDelta, changedVectors };
}

interface PassageRow { worldHash: string; count: number; maxDelta: number }
interface RetrievalRow {
  index: number; actionCount: number; matchesFrozenQuery: boolean;
  partialMatchesCold: boolean; warmMatchesCold: boolean; regeneratedMatchesCold: boolean;
  partialHits: number; partialMisses: number; warmMisses: number; passageMisses: number;
}
export function fullTextRetrievalConsistent(passages: readonly PassageRow[], rows: readonly RetrievalRow[], partialPopulation: number): boolean {
  return passages.length === 2 && new Set(passages.map(row => row.worldHash)).size === 2
    && passages.every(row => row.count > 0 && row.maxDelta === 0) && partialPopulation > 0
    && rows.length === 5 && JSON.stringify(rows.map(row => row.index)) === JSON.stringify([0, 1, 2, 3, 4])
    && JSON.stringify(rows.map(row => row.actionCount)) === JSON.stringify([12, 12, 12, 5, 8])
    && rows.every(row => row.matchesFrozenQuery && row.partialMatchesCold && row.warmMatchesCold && row.regeneratedMatchesCold
      && row.partialHits > 0 && row.partialMisses > 0 && row.warmMisses === 0 && row.passageMisses === 0);
}

export async function verifyFullTextWindowRetrieval(cacheSourceRoot: string, querySourceRoot: string, modelDirectory: string, outputRoot: string) {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked retrieval comparison before native execution");
  const codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const cacheManifestFile = path.join(cacheSourceRoot, "manifest.json"), queryManifestFile = path.join(querySourceRoot, "manifest.json");
  const cacheManifest = read<{ protocol: string; sourceRoot: string; sourceManifestSha256: string;
    sourceSha256: Array<{ B: string; C: string }>; actionIds: string[][] }>(cacheManifestFile);
  const queryManifest = read<{ protocol: string; sourceManifestSha256: string; graph: { sha256: string }; modelHash: string;
    contract: unknown; libraries: unknown; implementationHashes: Record<string, string>; sources: Array<{ B: string; C: string }> }>(queryManifestFile);
  const cachedResult = read<{ passed: boolean; counterexampleCovered: boolean }>(path.join(cacheSourceRoot, "result.json"));
  const queryResult = read<{ passed: boolean }>(path.join(querySourceRoot, "result.json"));
  if (cacheManifest.protocol !== "complete-query-batch-cache-v2" || !cachedResult.passed || !cachedResult.counterexampleCovered
    || queryManifest.protocol !== "full-text-window-encoder-v1" || !queryResult.passed
    || queryManifest.sourceManifestSha256 !== fileHash(cacheManifestFile)
    || cacheManifest.sourceManifestSha256 !== fileHash(path.join(cacheManifest.sourceRoot, "manifest.json"))
    || JSON.stringify(cacheManifest.actionIds.map(ids => ids.length)) !== JSON.stringify([12, 12, 12, 5, 8])
    || new Set(cacheManifest.actionIds.flat()).size !== 49) throw new Error("qualified complete source binding mismatch");
  const sources = cacheManifest.actionIds.map((actionIds, index) => {
    const files = Object.fromEntries(["B", "C"].map(arm => [arm, path.join(cacheManifest.sourceRoot, `preflight/source-${index}-${arm}/retrieval-1.json`)])) as Record<"B" | "C", string>;
    for (const arm of ["B", "C"] as const) if (fileHash(files[arm]) !== cacheManifest.sourceSha256[index]![arm]) throw new Error("frozen retrieval source drift");
    const oldFile = path.join(cacheSourceRoot, `source-${index}-cold.json`);
    if (fileHash(oldFile) !== queryManifest.sources[index]!.B
      || fileHash(path.join(cacheSourceRoot, `source-${index}-partial-prime.json`)) !== queryManifest.sources[index]!.C) throw new Error("query source drift");
    return { actionIds, B: read<RecordedSource>(files.B), C: read<RecordedSource>(files.C),
      old: read<{ selected: StoredSelection }>(oldFile).selected,
      frozenQuery: read<{ query: string[]; result: QueryBatchEncodingResult }>(path.join(querySourceRoot, `source-${index}-cold.json`)) };
  });
  const worlds = new Map<string, Set<string>>();
  const contexts = sources.flatMap((source, index) => (["B", "C"] as const).map(arm => {
    const request = source[arm].request, passages = r5RelationalPassagesForContext(request.fullContext);
    const union = worlds.get(request.worldContentHash) ?? new Set<string>();
    passages.forEach(row => union.add(row.passage));
    worlds.set(request.worldContentHash, union);
    return { index, arm, request, passages };
  }));
  mkdirSync(outputRoot, { recursive: false });
  const save = (name: string, value: unknown) => writeFileSync(path.join(outputRoot, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  let phase = "prepare", callCount = 0;
  const native = await loadFullTextWindowNative(modelDirectory, call => {
    save(`native-${String(callCount++).padStart(4, "0")}`, { phase, ...call });
    process.stdout.write(JSON.stringify({ phase, texts: call.texts.length, windows: call.plans.reduce((sum, windows) => sum + windows.length, 0),
      nativeBatches: call.shapes.length, elapsedMs: call.elapsedMs }) + "\n");
  });
  const { encoder, identity, fingerprint } = native;
  if (identity.graph.sha256 !== queryManifest.graph.sha256 || identity.modelHash !== queryManifest.modelHash
    || contentHash(identity.contract) !== contentHash(queryManifest.contract) || contentHash(identity.libraries) !== contentHash(queryManifest.libraries)
    || fileHash(FULL_TEXT_NATIVE_IMPLEMENTATION_FILES[1]!) !== queryManifest.implementationHashes[FULL_TEXT_NATIVE_IMPLEMENTATION_FILES[1]!]) {
    await native.dispose(); throw new Error("native inference differs from the qualified query candidate");
  }
  save("manifest", { protocol: "full-text-window-retrieval-v1", codeRevision, identity, fingerprint,
    cacheSourceManifestSha256: fileHash(cacheManifestFile), querySourceManifestSha256: fileHash(queryManifestFile),
    actionIds: cacheManifest.actionIds, sources: cacheManifest.sourceSha256,
    implementationHashes: Object.fromEntries(implementationFiles.map(file => [file, fileHash(file)])),
    preparation: "whole-world unions versus reverse-context partial population", ranking: { runtime: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
      budgetRatio: .2, compactKindBudgetRatio: .15, maxPathDepth: 3, pseudoSeedCount: 16 }, newModelHttp: 0, fullPlayerQualification: false });
  save("passage-sources", contexts.map(({ request, ...context }) => ({ ...context, worldHash: request.worldContentHash })));
  const wholeRoot = path.join(outputRoot, "whole-cache"), reverseRoot = path.join(outputRoot, "reverse-cache");
  const wholeWriter = new CachedPassageEncoder(encoder, fingerprint, wholeRoot), reverseWriter = new CachedPassageEncoder(encoder, fingerprint, reverseRoot);
  const population = [], preparationStarted = performance.now();
  let whole: CachedPassageEncoder | undefined, reverse: CachedPassageEncoder | undefined;
  try {
    for (const [worldHash, union] of worlds) {
      phase = `whole-${worldHash.slice(7, 15)}`;
      const passages = [...union].sort(), result = await wholeWriter.encodePassages({ worldContentHash: worldHash, passages, allowWrite: true });
      save(phase, { worldHash, passages, result });
      population.push({ kind: "whole", worldHash, hits: result.hits, misses: result.misses, written: result.written, encodeMs: result.encodeMs });
    }
    for (const context of [...contexts].reverse()) {
      phase = `reverse-${context.index}-${context.arm}`;
      const result = await reverseWriter.encodePassages({ worldContentHash: context.request.worldContentHash,
        passages: context.passages.map(row => row.passage), allowWrite: true });
      save(phase, result);
      population.push({ kind: "reverse", worldHash: context.request.worldContentHash, index: context.index, arm: context.arm,
        hits: result.hits, misses: result.misses, written: result.written, encodeMs: result.encodeMs });
    }
    wholeWriter.close(); reverseWriter.close();
    const preparationMs = performance.now() - preparationStarted;
    whole = new CachedPassageEncoder(encoder, fingerprint, wholeRoot, true);
    reverse = new CachedPassageEncoder(encoder, fingerprint, reverseRoot, true);
    const passageRows: PassageRow[] = [];
    for (const [worldHash, union] of worlds) {
      const before = callCount, passages = [...union].sort();
      const first = await whole.encodePassages({ worldContentHash: worldHash, passages, allowWrite: false });
      const second = await reverse.encodePassages({ worldContentHash: worldHash, passages, allowWrite: false });
      if (callCount !== before || first.misses || second.misses) throw new Error("read-only passage comparison encoded missing values");
      passageRows.push({ worldHash, count: passages.length, ...vectorDifference(first.vectors, second.vectors) });
    }
    save("passage-comparison", { population, preparationMs, passageRows });
    class Queries extends CachedQueryEncoder {
      latest?: { queries: readonly string[]; result: QueryBatchEncodingResult };
      override async encodeBatch(queries: readonly string[]) {
        const result = await super.encodeBatch(queries); this.latest = { queries: [...queries], result }; return result;
      }
    }
    const runtime = (passages: CachedPassageEncoder, query: Queries) => createActionCompilationRetrievalRuntime({
      version: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION, budgetRatio: .2,
      selectBatch: createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: .15 }),
      retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({ encoder, passageEncoder: passages, queryEncoder: query,
        maxPathDepth: 3, pseudoSeedCount: 16, allowPassageWrites: false }) });
    const run = async (label: string, request: Request, passages: CachedPassageEncoder, query: Queries) => {
      phase = label;
      const started = performance.now(), selected = await runtime(passages, query).retrieveBatch(request), elapsedMs = performance.now() - started;
      save(label, { selected: { ...selected, selectedKeysBySlot: Object.fromEntries(selected.selectedKeysBySlot) }, query: query.latest, elapsedMs });
      return { selected, elapsedMs };
    };
    const same = (left: CandidateSelectionResult, right: CandidateSelectionResult) => left.modelContextHash === right.modelContextHash
      && left.shortlistHash === right.shortlistHash && contentHash(left.modelContext) === contentHash(right.modelContext)
      && contentHash([...left.selectedKeysBySlot]) === contentHash([...right.selectedKeysBySlot]);
    const rows = [];
    for (const [index, source] of sources.entries()) {
      const coldQuery = new Queries(encoder), cold = await run(`source-${index}-cold`, source.B.request, whole, coldQuery);
      const matchesFrozenQuery = contentHash(coldQuery.latest!.queries) === contentHash(source.frozenQuery.query)
        && vectorDifference(source.frozenQuery.result.vectors, coldQuery.latest!.result.vectors).maxDelta === 0;
      const partialQuery = new Queries(encoder);
      await run(`source-${index}-prime`, source.C.request, whole, partialQuery);
      const partial = await run(`source-${index}-partial`, source.B.request, whole, partialQuery);
      const warm = await run(`source-${index}-warm`, source.B.request, whole, partialQuery);
      const regenerated = await run(`source-${index}-regenerated`, source.B.request, reverse, coldQuery);
      const catalog = (source.B.request.fullContext.referenceCatalog as { candidates: Array<{ candidateKey: string; kind: string; label: string }> }).candidates;
      const byKey = new Map(catalog.map(candidate => [candidate.candidateKey, candidate]));
      const differences = [...cold.selected.selectedKeysBySlot].map(([slot, selected]) => {
        const old = source.old.selectedKeysBySlot[String(slot)]!;
        return { slot, actionId: source.actionIds[slot], removed: old.filter(key => !selected.includes(key)).map(key => byKey.get(key)),
          added: selected.filter(key => !old.includes(key)).map(key => byKey.get(key)) };
      });
      save(`source-${index}-baseline-difference`, { differences, originalModelContextHash: source.old.modelContextHash,
        candidateModelContextHash: cold.selected.modelContextHash, originalDiagnostics: source.old.diagnostics, candidateDiagnostics: cold.selected.diagnostics });
      const cache = partial.selected.diagnostics.cache!;
      const row = { index, actionCount: source.actionIds.length, matchesFrozenQuery,
        partialMatchesCold: same(cold.selected, partial.selected), warmMatchesCold: same(cold.selected, warm.selected), regeneratedMatchesCold: same(cold.selected, regenerated.selected),
        partialHits: cache.queryHits, partialMisses: cache.queryMisses, warmMisses: warm.selected.diagnostics.cache!.queryMisses,
        passageMisses: [cold, partial, warm, regenerated].reduce((sum, value) => sum + value.selected.diagnostics.cache!.passageMisses, 0),
        coldMs: cold.elapsedMs, partialMs: partial.elapsedMs, warmMs: warm.elapsedMs, regeneratedMs: regenerated.elapsedMs,
        changedMemberships: differences.reduce((sum, difference) => sum + difference.added.length, 0), cache: {
          cold: cold.selected.diagnostics.cache, partial: partial.selected.diagnostics.cache, warm: warm.selected.diagnostics.cache, regenerated: regenerated.selected.diagnostics.cache } };
      rows.push(row); save(`source-${index}-summary`, row); process.stdout.write(JSON.stringify(row) + "\n");
    }
    const partialPopulation = population.filter(row => row.kind === "reverse" && row.hits > 0 && row.misses > 0).length;
    const result = { mechanicalCacheConsistency: fullTextRetrievalConsistent(passageRows, rows, partialPopulation),
      passageRows, partialPopulation, preparationMs, rows, newModelHttp: 0, sourceSemanticQualification: false, fullPlayerQualification: false };
    save("result", result); return result;
  } finally { wholeWriter.close(); reverseWriter.close(); whole?.close(); reverse?.close(); await native.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  globalThis.fetch = async () => { throw new Error("offline retrieval comparison forbids HTTP"); };
  const args = process.argv.slice(2);
  if (args.length !== 4) throw new Error("usage: verify-full-text-window-retrieval <complete-cache-source> <query-source> <fp32-model-directory> <new-output-root>");
  verifyFullTextWindowRetrieval(...args.map(value => path.resolve(value)) as [string, string, string, string]).then(result => {
    process.stdout.write(JSON.stringify({ mechanicalCacheConsistency: result.mechanicalCacheConsistency, newModelHttp: 0 }) + "\n");
    if (!result.mechanicalCacheConsistency) process.exitCode = 1;
  }).catch(error => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
