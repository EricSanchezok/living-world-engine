import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import {
  CachedQueryEncoder,
  discoverLocalEncoderModelDirectory,
  livingWorldCacheRoot,
  loadLocalEncoder,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import {
  createRelationalRrfPhysicalBatchRetriever,
  relationalRrfEncoderFingerprint,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { createCoverageAwareJointBudgetSelector } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import {
  ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
  createActionCompilationRetrievalRuntime,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import {
  evaluateActionCompilationRetrievalV4,
  type RetrievalV4Report,
} from "../../src/engine/benchmarks/action-compilation/retrieval-experiment-v4";
import { loadActionCompilationReferenceDataset } from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";

interface Options {
  dataset: string;
  output: string;
  cacheRoot: string;
  modelDirectory?: string;
  force: boolean;
}

function required(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parse(argv: readonly string[]): Options {
  const result: Options = {
    dataset: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/v1"),
    output: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-r5/production-verification.json"),
    cacheRoot: livingWorldCacheRoot(),
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dataset") result.dataset = path.resolve(required(argv, ++index, argument));
    else if (argument === "--output") result.output = path.resolve(required(argv, ++index, argument));
    else if (argument === "--cache-root") result.cacheRoot = path.resolve(required(argv, ++index, argument));
    else if (argument === "--model-dir") result.modelDirectory = path.resolve(required(argv, ++index, argument));
    else if (argument === "--force") result.force = true;
    else if (argument === "--help") throw new Error("usage: [--dataset <v1-dir>] [--output <json>] [--cache-root <dir>] [--model-dir <dir>] [--force]");
    else throw new Error(`unknown argument: ${argument}`);
  }
  return result;
}

function cacheTotals(report: RetrievalV4Report) {
  return report.batchResults.reduce((totals, batch) => ({
    passageHits: totals.passageHits + batch.cache.passageHits,
    passageMisses: totals.passageMisses + batch.cache.passageMisses,
    queryHits: totals.queryHits + batch.cache.queryHits,
    queryMisses: totals.queryMisses + batch.cache.queryMisses,
    queryBatchSize: totals.queryBatchSize + batch.cache.queryBatchSize,
    cacheReadMs: totals.cacheReadMs + batch.cache.readMs,
    passageEncodeMs: totals.passageEncodeMs + batch.cache.passageEncodeMs,
    queryEncodeMs: totals.queryEncodeMs + batch.cache.queryEncodeMs,
  }), {
    passageHits: 0,
    passageMisses: 0,
    queryHits: 0,
    queryMisses: 0,
    queryBatchSize: 0,
    cacheReadMs: 0,
    passageEncodeMs: 0,
    queryEncodeMs: 0,
  });
}

function queryBatchStats(report: RetrievalV4Report) {
  const values = report.batchResults.map((batch) => batch.cache.queryBatchSize).sort((left, right) => left - right);
  return {
    minimum: values[0] ?? 0,
    maximum: values.at(-1) ?? 0,
    mean: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: values.length === 0 ? 0 : values[Math.ceil(values.length * 0.95) - 1]!,
  };
}

function assertProductionBaseline(report: RetrievalV4Report): void {
  const close = (actual: number | null, expected: number, label: string) => {
    if (actual === null || Math.abs(actual - expected) > 1e-12) {
      throw new Error(`production relational RRF drifted in ${label}: expected ${expected}, got ${String(actual)}`);
    }
  };
  if (report.recalledKeys !== 545 || report.requiredKeys !== 609 || !report.deterministic || report.hardGate) {
    throw new Error(`production relational RRF drifted from its physical-batch baseline: ${JSON.stringify({
      recalledKeys: report.recalledKeys,
      requiredKeys: report.requiredKeys,
      microRecall: report.microRecall,
      macroRecall: report.macroRecall,
      averageBatchCompression: report.averageBatchCompression,
      p95BatchShortlistRatio: report.p95BatchShortlistRatio,
      deterministic: report.deterministic,
      hardGate: report.hardGate,
    })}`);
  }
  close(report.microRecall, 0.8949096880131363, "microRecall");
  close(report.macroRecall, 0.9071189878503713, "macroRecall");
  close(report.averageBatchCompression, 0.8003537994773703, "averageBatchCompression");
  close(report.p95BatchShortlistRatio, 0.19988833054159688, "p95BatchShortlistRatio");
}

export async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try {
    options = parse(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("usage:")) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 2;
  }
  try {
    const outputExists = existsSync(options.output);
    const dataset = loadActionCompilationReferenceDataset(options.dataset);
    const modelDirectory = options.modelDirectory ?? discoverLocalEncoderModelDirectory(
      options.cacheRoot,
      MULTILINGUAL_E5_BASE_ASSET.name,
    );
    const encoder = await loadLocalEncoder({
      modelDirectory,
      modelId: MULTILINGUAL_E5_BASE_ASSET.modelId,
      expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    });
    const encoderFingerprint = relationalRrfEncoderFingerprint(encoder);
    const passageEncoder = new CachedPassageEncoder(encoder, encoderFingerprint, options.cacheRoot, true);
    try {
      const queryEncoder = new CachedQueryEncoder(encoder);
      const runtime = createActionCompilationRetrievalRuntime({
        version: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
        budgetRatio: 0.2,
        retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({
          encoder,
          passageEncoder,
          queryEncoder,
          maxPathDepth: 3,
          pseudoSeedCount: 16,
          allowPassageWrites: false,
        }),
        selectBatch: createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: 0.15 }),
      });
      const coldStartedAt = performance.now();
      const cold = await evaluateActionCompilationRetrievalV4({
        dataset,
        algorithm: "candidate-selection/relational-rrf@2",
        runtime,
      });
      const coldWallMs = performance.now() - coldStartedAt;
      assertProductionBaseline(cold);
      const hotStartedAt = performance.now();
      const hot = await evaluateActionCompilationRetrievalV4({
        dataset,
        algorithm: "candidate-selection/relational-rrf@2",
        runtime,
      });
      const hotWallMs = performance.now() - hotStartedAt;
      assertProductionBaseline(hot);
      const output = {
        schemaVersion: 1,
        kind: "relational-rrf-production-verification",
        measuredAt: new Date().toISOString(),
        dataset: {
          id: dataset.manifest.datasetId,
          version: dataset.manifest.version,
          manifestSha256: createHash("sha256").update(readFileSync(path.join(options.dataset, "manifest.json"))).digest("hex"),
          cases: dataset.cases.length,
          contexts: dataset.contexts.size,
        },
        composition: {
          manifestHash: DEFAULT_ALGORITHM_REF.manifestHash,
          candidateSelection: DEFAULT_ALGORITHM_REF.children.actionCompilation?.children.candidateSelection,
        },
        encoder: {
          modelId: encoder.modelId,
          modelHash: encoder.modelHash,
          encoderFingerprint,
          dimensions: encoder.dimensions,
          revision: MULTILINGUAL_E5_BASE_ASSET.revision,
          onnxSha256: MULTILINGUAL_E5_BASE_ASSET.onnxSha256,
        },
        result: {
          recalledKeys: cold.recalledKeys,
          requiredKeys: cold.requiredKeys,
          microRecall: cold.microRecall,
          macroRecall: cold.macroRecall,
          averageBatchCompression: cold.averageBatchCompression,
          p95BatchShortlistRatio: cold.p95BatchShortlistRatio,
          deterministic: cold.deterministic && hot.deterministic,
          hardGate: false,
          policy: "explicitly-promoted-by-decision-0100",
        },
        historicalExperimentComparison: {
          artifact: "retrieval-r5/results.json#R5.5-multilingual-e5-base",
          recalledKeys: 547,
          requiredKeys: 609,
          microRecall: 0.8981937602627258,
          deltaRecalledKeys: cold.recalledKeys - 547,
          explanation: "The historical experiment pre-encoded queries across the whole dataset; production encodes one physical batch at a time. The pinned E5 runtime is batch-shape-sensitive, so production verification is authoritative for deployed behavior.",
        },
        performance: {
          subjectiveLatencyGateMs: null,
          logicalBatchesPerEvaluation: cold.batches,
          retrievalCallsPerEvaluation: cold.batches * 2,
          coldEvaluationWallMs: coldWallMs,
          hotEvaluationWallMs: hotWallMs,
          coldMeanWallMsPerRetrievalCall: coldWallMs / (cold.batches * 2),
          hotMeanWallMsPerRetrievalCall: hotWallMs / (hot.batches * 2),
          queryBatchSize: queryBatchStats(cold),
          coldFirstRequestPerBatch: cacheTotals(cold),
          hotFirstRequestPerBatch: cacheTotals(hot),
        },
        offline: { llmRequests: 0, networkRequests: 0, worldMutations: 0 },
      };
      const written = !outputExists || options.force;
      if (written) {
        mkdirSync(path.dirname(options.output), { recursive: true });
        writeFileSync(options.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      }
      process.stdout.write(`${JSON.stringify({
        output: options.output,
        written,
        result: output.result,
        performance: output.performance,
      }, null, 2)}\n`);
    } finally {
      passageEncoder.close();
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
