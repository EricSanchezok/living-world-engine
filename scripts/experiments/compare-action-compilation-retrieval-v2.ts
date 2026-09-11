import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RETRIEVAL_EXPERIMENT_POLICY,
  evaluateActionCompilationRetrieval,
  evaluateFullCatalogControl,
  type RetrievalExperimentPolicy,
  type RetrievalExperimentReport,
} from "../../src/engine/benchmarks/action-compilation/retrieval-experiment";
import {
  loadActionCompilationReferenceDataset,
  type ActionCompilationReferenceDataset,
} from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import {
  createActionCompilationRetriever,
  typedFullRetriever,
} from "../../src/engine/benchmarks/action-compilation/retrievers/core";
import {
  createActionCompilationAdvancedRetriever,
  type AdvancedActionCompilationStrategy,
} from "../../src/engine/benchmarks/action-compilation/retrievers/advanced";
import {
  discoverLocalEncoderModelDirectory,
  loadLocalEncoder,
  type LocalEncoderRuntime,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";

const ADVANCED_STRATEGIES: readonly AdvancedActionCompilationStrategy[] = [
  "structure-closure",
  "structure-bm25f",
  "encoder-anchor",
  "encoder-coverage",
  "hybrid",
  "retrieve-expand-refine",
];

const DEFAULT_OUTPUT = path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-structure-ab-v2");

interface Arguments {
  dataset: string;
  output: string;
  modelDirectory: string;
  deterministicOnly: boolean;
  force: boolean;
}

interface ExperimentRun {
  id: string;
  report: RetrievalExperimentReport;
  phase?: "formal" | "diagnostic";
}

interface ExperimentResults {
  schemaVersion: 2;
  kind: "action-compilation-retrieval-experiment-v2";
  datasetId: string;
  datasetVersion: number;
  datasetPath: string;
  offline: { llmRequests: 0; networkRequests: 0; worldMutations: 0 };
  policy: RetrievalExperimentPolicy;
  encoder: {
    modelId: string;
    modelHash: string;
    dimensions: number;
    libraryVersion: string | null;
    libraryHash: string | null;
    queryPrefix: "query: ";
    passagePrefix: "passage: ";
    pooling: "mean";
    normalize: true;
    search: "exact";
  } | null;
  evaluatedAt: string;
  runs: Array<{
    id: string;
    phase: "formal" | "diagnostic";
    budgetRatio: number;
    cases: number;
    requiredKeys: number;
    recalledKeys: number;
    microRecall: number | null;
    macroRecall: number | null;
    averageCompression: number;
    averageShortlistRatio: number;
    p95ShortlistRatio: number;
    minCaseRecall: number | null;
    p05CaseRecall: number | null;
    p10CaseRecall: number | null;
    invalidOutputCases: number;
    invalidOutputKeys: number;
    budgetExceededCases: number;
    deterministic: boolean;
    hardGate: boolean;
  }>;
  diagnostics: Array<{
    id: string;
    budgetRatio: number;
    report: ReturnType<typeof serialise>;
  }>;
  recommendation: {
    status: "candidate-selected" | "retain-fullcatalog";
    runId: string | null;
    reason: string;
  };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArguments(argv: readonly string[]): Arguments {
  let dataset = path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/v1");
  let output = DEFAULT_OUTPUT;
  let modelDirectory = "";
  let deterministicOnly = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dataset") dataset = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--output") output = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--model-dir") modelDirectory = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--model") {
      const model = requiredValue(argv, ++index, argument);
      modelDirectory = model === "multilingual-e5-small" ? "" : path.resolve(model);
    }
    else if (argument === "--deterministic-only") deterministicOnly = true;
    else if (argument === "--force") force = true;
    else if (argument === "--help") {
      throw new Error("usage: [--dataset <directory>] [--output <directory>] [--model-dir <directory>] [--deterministic-only] [--force]");
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return { dataset, output, modelDirectory, deterministicOnly, force };
}

function serialise(run: ExperimentRun) {
  const report = run.report;
  return {
    id: run.id,
    phase: run.phase ?? "formal",
    budgetRatio: report.policy.budgetRatio,
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
  };
}

function selectRecommendation(runs: readonly ExperimentRun[]): ExperimentResults["recommendation"] {
  const candidates = runs.filter((run) => run.report.hardGate && run.id !== "full-catalog" && run.id !== "typed-full");
  if (candidates.length === 0) {
    return {
      status: "retain-fullcatalog",
      runId: null,
      reason: "No non-control algorithm passed recall, compression, validity, budget, and determinism gates.",
    };
  }
  const selected = [...candidates].sort((left, right) =>
    (right.report.macroRecall ?? -1) - (left.report.macroRecall ?? -1) ||
    (right.report.microRecall ?? -1) - (left.report.microRecall ?? -1) ||
    left.report.p95ShortlistRatio - right.report.p95ShortlistRatio ||
    left.report.averageShortlistRatio - right.report.averageShortlistRatio ||
    left.id.localeCompare(right.id))[0]!;
  return {
    status: "candidate-selected",
    runId: selected.id,
    reason: "Selected the highest-macro-recall deterministic algorithm among runs passing all hard gates; ties prefer lower p95 and average shortlist ratios.",
  };
}

async function runAdvanced(
  dataset: ActionCompilationReferenceDataset,
  strategy: AdvancedActionCompilationStrategy,
  encoder: LocalEncoderRuntime | undefined,
  policy: RetrievalExperimentPolicy,
  allowDiagnosticBudget = false,
): Promise<ExperimentRun> {
  const retriever = await createActionCompilationAdvancedRetriever(strategy, dataset, {
    budgetRatio: policy.budgetRatio,
    closureDepth: 3,
    allowDiagnosticBudget,
    ...(encoder === undefined ? {} : { encoder }),
  });
  return {
    id: strategy,
    phase: allowDiagnosticBudget ? "diagnostic" : "formal",
    report: evaluateActionCompilationRetrieval(dataset, retriever, strategy, policy),
  };
}

function bestObservedRun(runs: readonly ExperimentRun[]): ExperimentRun | undefined {
  return runs
    .filter((run) => run.id !== "full-catalog" && run.id !== "typed-full")
    .sort((left, right) =>
      (right.report.macroRecall ?? -1) - (left.report.macroRecall ?? -1) ||
      (right.report.microRecall ?? -1) - (left.report.microRecall ?? -1) ||
      left.report.p95ShortlistRatio - right.report.p95ShortlistRatio ||
      left.id.localeCompare(right.id))[0];
}

async function runDiagnostic(
  dataset: ActionCompilationReferenceDataset,
  observed: ExperimentRun,
  encoder: LocalEncoderRuntime | undefined,
  budgetRatio: number,
): Promise<ExperimentRun> {
  const policy: RetrievalExperimentPolicy = {
    ...DEFAULT_RETRIEVAL_EXPERIMENT_POLICY,
    budgetRatio,
  };
  if (observed.id === "current-anchor-plus-lexical") {
    const retriever = createActionCompilationRetriever("anchor-plus-lexical", { budgetRatio });
    return {
      id: `${observed.id}-budget${Math.round(budgetRatio * 100)}`,
      phase: "diagnostic",
      report: evaluateActionCompilationRetrieval(dataset, retriever, `${observed.id}-budget${Math.round(budgetRatio * 100)}`, policy),
    };
  }
  return {
    ...(await runAdvanced(dataset, observed.id as AdvancedActionCompilationStrategy, encoder, policy, true)),
    id: `${observed.id}-budget${Math.round(budgetRatio * 100)}`,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Arguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("usage:")) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 2;
  }
  const resultFile = path.join(args.output, "results.json");
  try {
    if (!args.force && existsSync(resultFile)) throw new Error(`evaluation output already exists: ${resultFile} (use --force to replace it)`);
    const dataset = loadActionCompilationReferenceDataset(args.dataset);
    const policy = DEFAULT_RETRIEVAL_EXPERIMENT_POLICY;
    const runs: ExperimentRun[] = [{ id: "full-catalog", report: evaluateFullCatalogControl(dataset, policy) }];
    runs.push({ id: "typed-full", report: evaluateActionCompilationRetrieval(dataset, typedFullRetriever, "typed-full", policy) });
    runs.push({
      id: "current-anchor-plus-lexical",
      report: evaluateActionCompilationRetrieval(
        dataset,
        createActionCompilationRetriever("anchor-plus-lexical", { budgetRatio: policy.budgetRatio }),
        "current-anchor-plus-lexical",
        policy,
      ),
    });
    let encoder: LocalEncoderRuntime | undefined;
    if (!args.deterministicOnly) {
      const modelDirectory = args.modelDirectory || discoverLocalEncoderModelDirectory();
      encoder = await loadLocalEncoder({ modelDirectory });
    }
    for (const strategy of ADVANCED_STRATEGIES) {
      if (args.deterministicOnly && strategy.startsWith("encoder")) continue;
      if (args.deterministicOnly && (strategy === "hybrid" || strategy === "retrieve-expand-refine")) continue;
      runs.push(await runAdvanced(dataset, strategy, encoder, policy));
    }
    const recommendation = selectRecommendation(runs);
    const diagnostics: ExperimentRun[] = [];
    if (recommendation.status === "retain-fullcatalog") {
      const observed = bestObservedRun(runs);
      if (observed) {
        diagnostics.push(await runDiagnostic(dataset, observed, encoder, 0.25));
        diagnostics.push(await runDiagnostic(dataset, observed, encoder, 0.3));
      }
    }
    const output: ExperimentResults = {
      schemaVersion: 2,
      kind: "action-compilation-retrieval-experiment-v2",
      datasetId: dataset.manifest.datasetId,
      datasetVersion: dataset.manifest.version,
      datasetPath: path.relative(process.cwd(), dataset.root) || ".",
      offline: { llmRequests: 0, networkRequests: 0, worldMutations: 0 },
      policy,
      encoder: encoder ? {
        modelId: encoder.modelId,
        modelHash: encoder.modelHash,
        dimensions: encoder.dimensions,
        libraryVersion: encoder.libraryVersion ?? null,
        libraryHash: encoder.libraryHash ?? null,
        queryPrefix: "query: ",
        passagePrefix: "passage: ",
        pooling: "mean",
        normalize: true,
        search: "exact",
      } : null,
      evaluatedAt: new Date().toISOString(),
      runs: runs.map(serialise),
      diagnostics: diagnostics.map((run) => ({ id: run.id, budgetRatio: run.report.policy.budgetRatio, report: serialise(run) })),
      recommendation,
    };
    mkdirSync(args.output, { recursive: true });
    writeFileSync(resultFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    const reports = path.join(args.output, "reports");
    mkdirSync(reports, { recursive: true });
    for (const run of runs) writeFileSync(path.join(reports, `${run.id}.json`), `${JSON.stringify(run.report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ output: resultFile, recommendation, runs: output.runs.map((run) => ({ id: run.id, hardGate: run.hardGate, microRecall: run.microRecall, macroRecall: run.macroRecall, averageCompression: run.averageCompression, p95ShortlistRatio: run.p95ShortlistRatio })) }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
