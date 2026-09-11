import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { createRuntimeGraphSlotRetriever } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/graph-aware";
import {
  discoverLocalEncoderModelDirectory,
  livingWorldCacheRoot,
  loadLocalEncoder,
  localEncoderFingerprint,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { createActionCompilationRetrievalRuntime } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import { ACTION_COMPILATION_PASSAGE_SCHEMA_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/graph-aware";
import { evaluateActionCompilationRetrievalV4, evaluateFullCatalogControlV4 } from "../../src/engine/benchmarks/action-compilation/retrieval-experiment-v4";
import { loadActionCompilationReferenceDataset } from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";

interface Options {
  dataset: string;
  output: string;
  cacheRoot: string;
  modelDirectory?: string;
  force: boolean;
}

function value(argv: readonly string[], index: number, option: string): string {
  const result = argv[index];
  if (!result || result.startsWith("--")) throw new Error(`${option} requires a value`);
  return result;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    dataset: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/v1"),
    output: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-runtime-ab-v4"),
    cacheRoot: livingWorldCacheRoot(),
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--dataset") options.dataset = path.resolve(value(argv, ++index, argument));
    else if (argument === "--output") options.output = path.resolve(value(argv, ++index, argument));
    else if (argument === "--cache-root") options.cacheRoot = path.resolve(value(argv, ++index, argument));
    else if (argument === "--model-dir") options.modelDirectory = path.resolve(value(argv, ++index, argument));
    else if (argument === "--force") options.force = true;
    else if (argument === "--help" || argument === "-h") throw new Error("usage: [--dataset <dir>] [--output <dir>] [--cache-root <dir>] [--model-dir <dir>] [--force]");
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main(argv: readonly string[]): Promise<number> {
  let options: Options;
  try { options = parseArgs(argv); } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("usage:")) { process.stdout.write(`${message}\n`); return 0; }
    process.stderr.write(`${message}\n`); return 2;
  }
  try {
    const resultFile = path.join(options.output, "results.json");
    if (existsSync(resultFile) && !options.force) throw new Error(`evaluation output already exists: ${resultFile} (use --force to replace it)`);
    const dataset = loadActionCompilationReferenceDataset(options.dataset);
    const modelDirectory = options.modelDirectory ?? discoverLocalEncoderModelDirectory(options.cacheRoot);
    const encoder = await loadLocalEncoder({ modelDirectory });
    const passageEncoder = new CachedPassageEncoder(
      encoder,
      localEncoderFingerprint(encoder, ACTION_COMPILATION_PASSAGE_SCHEMA_VERSION),
      options.cacheRoot,
      true,
    );
    try {
      const runtime = createActionCompilationRetrievalRuntime({
        version: "action-compilation-retrieval-runtime-v6",
        budgetRatio: 0.2,
        retrieveSlot: createRuntimeGraphSlotRetriever({
          strategy: "graph-hybrid",
          encoder,
          passageEncoder,
          maxPathDepth: 3,
        }),
      });
      const report = await evaluateActionCompilationRetrievalV4({ dataset, algorithm: "H2-runtime-joint-budget", runtime });
      const control = evaluateFullCatalogControlV4(dataset);
      const datasetManifestHash = `sha256:${createHash("sha256")
        .update(readFileSync(path.join(options.dataset, "manifest.json")))
        .digest("hex")}`;
      const output = {
        schemaVersion: 4,
        kind: "action-compilation-retrieval-experiment-v4",
        datasetId: dataset.manifest.datasetId,
        datasetVersion: dataset.manifest.version,
        offline: { llmRequests: 0, networkRequests: 0, worldMutations: 0 },
        encoder: {
          modelId: encoder.modelId,
          modelHash: encoder.modelHash,
          encoderFingerprint: passageEncoder.encoderFingerprint,
          dimensions: encoder.dimensions,
          libraryVersion: encoder.libraryVersion ?? null,
          libraryHash: encoder.libraryHash ?? null,
        },
        activation: {
          datasetManifestHash,
          worldContentHashes: [...new Set(dataset.cases.map((item) => item.source.worldHash))].sort(),
          replayMatched: false,
        },
        runs: [control, report],
        recommendation: report.hardGate
          ? { status: "candidate-selected", runId: report.algorithm }
          : { status: "retain-fullcatalog", runId: null },
      };
      mkdirSync(options.output, { recursive: true });
      writeFileSync(resultFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
      process.stdout.write(`${JSON.stringify({ output: resultFile, report: {
        microRecall: report.microRecall,
        macroRecall: report.macroRecall,
        averageBatchCompression: report.averageBatchCompression,
        p95BatchShortlistRatio: report.p95BatchShortlistRatio,
        deterministic: report.deterministic,
        hardGate: report.hardGate,
      }, recommendation: output.recommendation }, null, 2)}\n`);
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
