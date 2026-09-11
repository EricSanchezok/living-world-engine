import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeJsonlGzip,
  loadActionCompilationReferenceDataset,
} from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import { regenerateActionCompilationFullCatalog } from "../../src/engine/benchmarks/action-compilation/fullcatalog-regenerator";
import {
  validateActionCompilationCapturedSource,
  type RawBenchmarkSource,
  type RegeneratedActionCompilationReference,
} from "../../src/engine/benchmarks/source-capture";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { LocalDatabase } from "../../src/server/local-database";
import { captureActionCompilationSources } from "./capture-action-compilation-source";
import {
  assertReferenceRefreshCompatibility,
  countValues,
  mergeActionCompilationReferenceData,
  publishActionCompilationReferenceData,
} from "../../src/engine/benchmarks/action-compilation/reference-refresh";

interface Args {
  database: string;
  instanceId?: string;
  executionIds: string[];
  sourceFiles: string[];
  base: string;
  outputRoot: string;
  version: number;
  dryRun: boolean;
}

function required(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parse(argv: readonly string[]): Args {
  const result: Args = {
    database: path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23", "livingworld.sqlite"),
    executionIds: [],
    sourceFiles: [],
    base: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized/v1"),
    outputRoot: path.resolve("benchmarks/action-compilation/fullcatalog-stabilized"),
    version: 2,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--database") result.database = path.resolve(required(argv, ++index, argument));
    else if (argument === "--instance") result.instanceId = required(argv, ++index, argument);
    else if (argument === "--execution") result.executionIds.push(required(argv, ++index, argument));
    else if (argument === "--source") result.sourceFiles.push(path.resolve(required(argv, ++index, argument)));
    else if (argument === "--base") result.base = path.resolve(required(argv, ++index, argument));
    else if (argument === "--output") result.outputRoot = path.resolve(required(argv, ++index, argument));
    else if (argument === "--version") result.version = Number(required(argv, ++index, argument));
    else if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--help") throw new Error("usage: [--instance <id>] [--execution <id> ...] [--source <sources-000.jsonl.gz> ...] --base <v1-dir> --version <n> [--database <sqlite>] [--output <dataset-root>] [--dry-run]");
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.instanceId && result.executionIds.length === 0 && result.sourceFiles.length === 0) {
    throw new Error("provide --instance, at least one --execution, or an official --source shard");
  }
  if (!Number.isSafeInteger(result.version) || result.version < 2) throw new Error("--version must be an integer of at least 2");
  result.executionIds = [...new Set(result.executionIds)].sort();
  result.sourceFiles = [...new Set(result.sourceFiles)].sort();
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function loadOfficialSourceShard(input: string): RawBenchmarkSource[] {
  const file = path.basename(input) === "sources-000.jsonl.gz" ? input : path.join(input, "sources-000.jsonl.gz");
  const manifestFile = path.join(path.dirname(file), "manifest.json");
  if (!existsSync(file) || !existsSync(manifestFile)) {
    throw new Error(`official source capture requires sources-000.jsonl.gz and its sibling manifest.json: ${input}`);
  }
  const manifest = object(JSON.parse(readFileSync(manifestFile, "utf8")) as unknown, "source manifest");
  const bytes = readFileSync(file);
  if (manifest.schemaVersion !== 2 || manifest.kind !== "action-compilation-source-capture" ||
    manifest.file !== "sources-000.jsonl.gz" || manifest.sha256 !== sha256(bytes) ||
    !Number.isSafeInteger(manifest.records)) {
    throw new Error(`source capture manifest/hash is invalid: ${manifestFile}`);
  }
  const records = decodeJsonlGzip<unknown>(bytes, file).map(validateActionCompilationCapturedSource);
  if (records.length !== manifest.records) throw new Error(`source capture record count does not match ${manifestFile}`);
  return records;
}

function updateRegistry(version: number, target: string): void {
  const file = path.resolve("benchmarks/registry.json");
  const registry = object(JSON.parse(readFileSync(file, "utf8")) as unknown, "benchmark registry");
  const entries = Array.isArray(registry.benchmarks) ? registry.benchmarks as Array<Record<string, unknown>> : [];
  if (entries.some((entry) => entry.datasetId === "action-compilation/fullcatalog-stabilized" && entry.version === version)) {
    throw new Error(`benchmark registry already contains immutable v${version}`);
  }
  entries.push({
    datasetId: "action-compilation/fullcatalog-stabilized",
    version,
    domain: "candidate-retrieval-recall",
    purpose: "Compare replaceable shortlist algorithms against regenerated FullCatalog behavioral references.",
    status: "frozen",
    path: path.relative(process.cwd(), target),
    source: "Immutable v1 lineage plus manually selected R5 Ledger captures regenerated through FullCatalog",
    exporter: "npm run benchmark:refresh:action-compilation-reference -- --instance <id> --base benchmarks/action-compilation/fullcatalog-stabilized/v1 --version 2",
    evaluator: "npm run benchmark:evaluate:action-compilation-reference -- --dataset <path> --retriever <module>",
    maintainer: "Living World Engine team",
    notes: "Schema v2 separates capture and reference Composition hashes and reports base-v1/r5-captured strata.",
  });
  entries.sort((left, right) => Number(left.version) - Number(right.version));
  registry.benchmarks = entries;
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function ledgerSources(args: Args): RawBenchmarkSource[] {
  if (!args.instanceId && args.executionIds.length === 0) return [];
  const database = new LocalDatabase(args.database, { readOnly: true, heartbeat: false });
  try {
    const ids = new Set(args.executionIds);
    if (args.instanceId) {
      for (const execution of database.executions({ instanceId: args.instanceId })) {
        if (database.executionEvents(execution.id).some((event) => event.event === "model.action_compilation.context.captured")) {
          ids.add(execution.id);
        }
      }
    }
    if (ids.size === 0) throw new Error("selected instance/executions contain no Action Compilation capture events");
    return captureActionCompilationSources(database, [...ids].sort());
  } finally {
    database.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parse(argv);
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
    const base = loadActionCompilationReferenceDataset(args.base);
    const sources = [
      ...ledgerSources(args),
      ...args.sourceFiles.flatMap(loadOfficialSourceShard),
    ];
    const unique = new Map<string, RawBenchmarkSource>();
    for (const source of sources) {
      const key = `${source.sourceExecutionId}:${source.sourceInvocationId}`;
      const current = unique.get(key);
      if (current && contentHash(current) !== contentHash(source)) throw new Error(`conflicting captured source ${key}`);
      unique.set(key, source);
    }
    const orderedSources = [...unique.values()].sort((left, right) =>
      left.sourceExecutionId.localeCompare(right.sourceExecutionId) || left.sourceInvocationId.localeCompare(right.sourceInvocationId));
    assertReferenceRefreshCompatibility(base, orderedSources);
    const summary = {
      base: args.base,
      output: path.join(args.outputRoot, `v${args.version}`),
      sourceRecords: orderedSources.length,
      sourceExecutions: [...new Set(orderedSources.map((source) => source.sourceExecutionId))].sort(),
      databaseReadOnly: true,
      dryRun: args.dryRun,
    };
    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify({ ...summary, providerRequests: 0 }, null, 2)}\n`);
      return 0;
    }
    const target = summary.output;
    if (existsSync(target)) throw new Error(`frozen dataset output already exists: ${target}`);
    const catalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
    if (catalog.hash !== orderedSources[0]!.modelCatalogHash) {
      throw new Error("installed model catalog does not match captured modelCatalogHash");
    }
    const dataRoot = path.dirname(args.database);
    const registry = new ModelRegistry(catalog, dataRoot, { minimumRefreshIntervalMs: 0 });
    const provider = createModelGateway(catalog, process.env, {
      registry,
      fetchForAccount: createModelFetchResolver(process.env),
    });
    const startedAt = new Date().toISOString();
    const references: RegeneratedActionCompilationReference[] = [];
    for (const source of orderedSources) references.push(await regenerateActionCompilationFullCatalog(source, provider));
    const completedAt = new Date().toISOString();
    const refreshed = mergeActionCompilationReferenceData({
      base,
      sources: orderedSources,
      references,
      version: args.version,
      startedAt,
      completedAt,
    });
    publishActionCompilationReferenceData(refreshed, target);
    updateRegistry(args.version, target);
    process.stdout.write(`${JSON.stringify({
      ...summary,
      providerRequests: references.reduce((sum, reference) => sum + reference.providerRequests, 0),
      cases: refreshed.cases.length,
      contexts: refreshed.contexts.length,
      strata: countValues(refreshed.cases.map((item) => item.stratum ?? "unstratified")),
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`benchmark refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
