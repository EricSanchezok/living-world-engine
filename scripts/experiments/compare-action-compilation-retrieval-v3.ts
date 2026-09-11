import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RETRIEVAL_EXPERIMENT_POLICY,
  type RetrievalExperimentPolicy,
} from "../../src/engine/benchmarks/action-compilation/retrieval-experiment";
import {
  evaluateActionCompilationRetrievalV3,
  evaluateFullCatalogControlV3,
  type RetrievalV3Report,
} from "../../src/engine/benchmarks/action-compilation/retrieval-experiment-v3";
import {
  loadActionCompilationReferenceDataset,
  type ActionCompilationReferenceDataset,
} from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import { createActionCompilationRetriever, typedFullRetriever } from "../../src/engine/benchmarks/action-compilation/retrievers/core";
import {
  createGraphAwareActionCompilationRetriever,
  type GraphAwareStrategy,
  type GraphRankerModel,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/graph-aware";
import { loadLocalEncoder, hashLocalModelDirectory, LOCAL_ENCODER_MAX_BATCH_SIZE, LOCAL_ENCODER_MAX_TOKENS, type LocalEncoderRuntime } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { discoverLocalEncoderModelDirectory, livingWorldCacheRoot, localEncoderFingerprint } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";

const DEFAULT_DATASET = path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/v1");
const DEFAULT_OUTPUT = path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-graph-ab-v3");
const DEFAULT_CACHE_ROOT = livingWorldCacheRoot();

interface Args {
  dataset: string;
  output: string;
  modelDirectory: string;
  cacheRoot: string;
  ranker?: string;
  deterministicOnly: boolean;
  force: boolean;
  bootstrapSamples: number;
}

interface Run {
  id: string;
  status: "completed" | "blocked";
  phase?: "formal" | "diagnostic";
  report?: RetrievalV3Report;
  reason?: string;
}

function value(argv: readonly string[], index: number, option: string): string {
  const result = argv[index];
  if (!result || result.startsWith("--")) throw new Error(`${option} requires a value`);
  return result;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dataset: DEFAULT_DATASET, output: DEFAULT_OUTPUT, modelDirectory: "", cacheRoot: DEFAULT_CACHE_ROOT, deterministicOnly: false, force: false, bootstrapSamples: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dataset") args.dataset = path.resolve(value(argv, ++index, argument));
    else if (argument === "--output") args.output = path.resolve(value(argv, ++index, argument));
    else if (argument === "--model-dir") args.modelDirectory = path.resolve(value(argv, ++index, argument));
    else if (argument === "--cache-root") args.cacheRoot = path.resolve(value(argv, ++index, argument));
    else if (argument === "--model") {
      const model = value(argv, ++index, argument);
      args.modelDirectory = model === "multilingual-e5-small" ? "" : path.resolve(model);
    } else if (argument === "--ranker") args.ranker = path.resolve(value(argv, ++index, argument));
    else if (argument === "--deterministic-only") args.deterministicOnly = true;
    else if (argument === "--bootstrap-samples") args.bootstrapSamples = Number(value(argv, ++index, argument));
    else if (argument === "--force") args.force = true;
    else if (argument === "--help") throw new Error("usage: --dataset <dir> --output <dir> [--model-dir <dir>] [--cache-root <dir>] [--ranker <json>] [--deterministic-only] [--bootstrap-samples <n>] [--force]");
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(args.bootstrapSamples) || args.bootstrapSamples < 1) throw new Error("--bootstrap-samples must be a positive integer");
  return args;
}

function loadRanker(file: string | undefined): GraphRankerModel | undefined {
  if (!file) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const ranker = object && "ranker" in object ? object.ranker as GraphRankerModel | undefined : parsed as GraphRankerModel;
  if (!ranker || ranker.schemaVersion !== 1 || !Array.isArray(ranker.weights) || !Array.isArray(ranker.featureNames)) {
    throw new Error(`invalid graph ranker artifact: ${file}`);
  }
  return ranker;
}

function serialise(run: Run): Record<string, unknown> {
  if (!run.report) return { id: run.id, status: run.status, reason: run.reason };
  const report = run.report;
  return {
    id: run.id,
    status: run.status,
    phase: run.phase ?? "formal",
    cases: report.cases,
    requiredKeys: report.requiredKeys,
    recalledKeys: report.recalledKeys,
    microRecall: report.microRecall,
    macroRecall: report.macroRecall,
    averageCompression: report.averageCompression,
    averageShortlistRatio: report.averageShortlistRatio,
    p95ShortlistRatio: report.p95ShortlistRatio,
    minCaseRecall: report.minCaseRecall,
    p05CaseRecall: report.p05CaseRecall,
    p10CaseRecall: report.p10CaseRecall,
    invalidOutputCases: report.invalidOutputCases,
    invalidOutputKeys: report.invalidOutputKeys,
    budgetExceededCases: report.budgetExceededCases,
    deterministic: report.deterministic,
    hardGate: report.hardGate,
    confidenceIntervals: report.confidenceIntervals,
    graphDiagnostics: report.graphDiagnostics,
  };
}

async function evaluate(
  dataset: ActionCompilationReferenceDataset,
  id: string,
  retriever: Awaited<ReturnType<typeof createGraphAwareActionCompilationRetriever>>,
  policy: RetrievalExperimentPolicy,
  bootstrapSamples: number,
): Promise<Run> {
  return { id, status: "completed", report: evaluateActionCompilationRetrievalV3(dataset, retriever, id, policy, { bootstrapSamples }) };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try { args = parseArgs(argv); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("usage:")) { process.stdout.write(`${message}\n`); return 0; }
    process.stderr.write(`${message}\n`); return 2;
  }
  try {
    if (!args.modelDirectory && !args.deterministicOnly) args.modelDirectory = discoverLocalEncoderModelDirectory(args.cacheRoot);
    const resultFile = path.join(args.output, "results.json");
    if (!args.force && existsSync(resultFile)) throw new Error(`evaluation output already exists: ${resultFile} (use --force to replace it)`);
    const dataset = loadActionCompilationReferenceDataset(args.dataset);
    const policy = DEFAULT_RETRIEVAL_EXPERIMENT_POLICY;
    const runs: Run[] = [];
    runs.push({ id: "A0-full-catalog", status: "completed", report: evaluateFullCatalogControlV3(dataset, policy, { bootstrapSamples: args.bootstrapSamples }) });
    runs.push({ id: "A1-typed-full", status: "completed", report: evaluateActionCompilationRetrievalV3(dataset, typedFullRetriever, "A1-typed-full", policy, { bootstrapSamples: args.bootstrapSamples }) });
    runs.push({ id: "D1-anchor-lexical", status: "completed", report: evaluateActionCompilationRetrievalV3(dataset, createActionCompilationRetriever("anchor-plus-lexical", { budgetRatio: policy.budgetRatio }), "D1-anchor-lexical", policy, { bootstrapSamples: args.bootstrapSamples }) });

    const graphRuns: Array<{ id: string; strategy: GraphAwareStrategy; depth: number; needsEncoder?: boolean; ranker?: GraphRankerModel }> = [
      { id: "G1-typed-one-hop", strategy: "graph-one-hop", depth: 1 },
      { id: "G2-role-constrained", strategy: "graph-role", depth: 2 },
      { id: "G3-role-bm25f-alias", strategy: "graph-role", depth: 3 },
    ];
    const ranker = loadRanker(args.ranker);
    if (!args.deterministicOnly) {
      graphRuns.push({ id: "E1-encoder-anchor", strategy: "graph-encoder", depth: 1, needsEncoder: true });
      graphRuns.push({ id: "H1-graph-encoder-hybrid", strategy: "graph-hybrid", depth: 2, needsEncoder: true });
      graphRuns.push({ id: "H2-coverage-aware-hybrid", strategy: "graph-hybrid", depth: 3, needsEncoder: true });
      if (ranker) {
        graphRuns.push({ id: "L1-learned-reranker", strategy: "graph-learned", depth: 3, needsEncoder: true, ranker });
        graphRuns.push({ id: "L2-calibrated-reranker", strategy: "graph-learned", depth: 4, needsEncoder: true, ranker });
      } else {
        runs.push({ id: "L1-learned-reranker", status: "blocked", reason: "ranker artifact not supplied; current 46-case dataset is exploratory only" });
        runs.push({ id: "L2-calibrated-reranker", status: "blocked", reason: "ranker artifact not supplied; current 46-case dataset is exploratory only" });
      }
    }
    let encoder: LocalEncoderRuntime | undefined;
    let passageEncoder: CachedPassageEncoder | undefined;
    if (graphRuns.some((run) => run.needsEncoder)) {
      if (!existsSync(args.modelDirectory)) {
        for (const run of graphRuns.filter((candidate) => candidate.needsEncoder)) runs.push({ id: run.id, status: "blocked", reason: `local encoder asset missing: ${args.modelDirectory}` });
      } else {
        encoder = await loadLocalEncoder({ modelDirectory: args.modelDirectory });
        passageEncoder = new CachedPassageEncoder(encoder, localEncoderFingerprint(encoder, 1), args.cacheRoot);
      }
    }
    for (const config of graphRuns) {
      if (runs.some((run) => run.id === config.id)) continue;
      if (config.needsEncoder && !encoder) continue;
      const retriever = await createGraphAwareActionCompilationRetriever(config.strategy, dataset, {
        budgetRatio: policy.budgetRatio,
        maxPathDepth: config.depth,
        ...(encoder ? { encoder } : {}),
        ...(passageEncoder ? { passageEncoder } : {}),
        ...(config.ranker ? { ranker: config.ranker } : {}),
      });
      runs.push(await evaluate(dataset, config.id, retriever, policy, args.bootstrapSamples));
    }
    const diagnostics: Run[] = [];
    const observed = runs.filter((run) => run.status === "completed" && run.report && !run.id.startsWith("A0-") && !run.id.startsWith("A1-"))
      .sort((left, right) => (right.report!.macroRecall ?? -1) - (left.report!.macroRecall ?? -1) || (right.report!.microRecall ?? -1) - (left.report!.microRecall ?? -1) || left.id.localeCompare(right.id))[0];
    if (!runs.some((run) => run.report?.hardGate) && observed) {
      for (const ratio of [0.25, 0.3]) {
        const diagnosticPolicy = { ...policy, budgetRatio: ratio };
        if (observed.id === "D1-anchor-lexical") {
          diagnostics.push({ id: `${observed.id}-budget${Math.round(ratio * 100)}`, phase: "diagnostic", status: "completed", report: evaluateActionCompilationRetrievalV3(dataset, createActionCompilationRetriever("anchor-plus-lexical", { budgetRatio: ratio }), `${observed.id}-budget${Math.round(ratio * 100)}`, diagnosticPolicy, { bootstrapSamples: args.bootstrapSamples }) });
        } else {
          const config = graphRuns.find((candidate) => candidate.id === observed.id);
          if (!config || (config.needsEncoder && !encoder)) continue;
          const retriever = await createGraphAwareActionCompilationRetriever(config.strategy, dataset, { budgetRatio: ratio, maxPathDepth: config.depth, allowDiagnosticBudget: true, ...(encoder ? { encoder } : {}), ...(passageEncoder ? { passageEncoder } : {}), ...(config.ranker ? { ranker: config.ranker } : {}) });
          diagnostics.push({ id: `${observed.id}-budget${Math.round(ratio * 100)}`, phase: "diagnostic", status: "completed", report: evaluateActionCompilationRetrievalV3(dataset, retriever, `${observed.id}-budget${Math.round(ratio * 100)}`, diagnosticPolicy, { bootstrapSamples: args.bootstrapSamples }) });
        }
      }
    }
    const successful = runs.filter((run) => run.status === "completed" && run.report && run.id !== "A0-full-catalog" && run.id !== "A1-typed-full");
    const eligible = successful.filter((run) => run.report!.hardGate);
    const selected = [...eligible].sort((left, right) =>
      (right.report!.macroRecall ?? -1) - (left.report!.macroRecall ?? -1) ||
      (right.report!.microRecall ?? -1) - (left.report!.microRecall ?? -1) ||
      left.report!.p95ShortlistRatio - right.report!.p95ShortlistRatio || left.id.localeCompare(right.id))[0];
    const output = {
      schemaVersion: 3,
      kind: "action-compilation-retrieval-experiment-v3",
      datasetId: dataset.manifest.datasetId,
      datasetVersion: dataset.manifest.version,
      datasetPath: path.relative(process.cwd(), dataset.root) || ".",
      offline: { llmRequests: 0, networkRequests: 0, worldMutations: 0 },
      policy,
      encoder: encoder ? { modelId: encoder.modelId, modelHash: encoder.modelHash, dimensions: encoder.dimensions, modelDirectoryHash: hashLocalModelDirectory(args.modelDirectory), libraryVersion: encoder.libraryVersion ?? null, libraryHash: encoder.libraryHash ?? null, queryPrefix: "query: ", passagePrefix: "passage: ", pooling: "mean", normalize: true, truncation: true, maxTokens: LOCAL_ENCODER_MAX_TOKENS, maxBatchSize: LOCAL_ENCODER_MAX_BATCH_SIZE, search: "exact" } : null,
      evaluatedAt: new Date().toISOString(),
      runs: runs.map(serialise),
      diagnostics: diagnostics.map(serialise),
      recommendation: selected ? { status: "candidate-selected", runId: selected.id, reason: "highest macro recall among runs passing all v3 hard gates" } : { status: "retain-fullcatalog", runId: null, reason: "No non-control run passed the v3 hard gates; retain FullCatalog." },
    };
    mkdirSync(path.join(args.output, "reports"), { recursive: true });
    writeFileSync(resultFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    for (const run of runs) if (run.report) writeFileSync(path.join(args.output, "reports", `${run.id}.json`), `${JSON.stringify(run.report, null, 2)}\n`, "utf8");
    passageEncoder?.close();
    process.stdout.write(`${JSON.stringify({ output: resultFile, recommendation: output.recommendation, runs: output.runs }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
