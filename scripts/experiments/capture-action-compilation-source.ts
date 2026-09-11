import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalDatabase } from "../../src/server/local-database";
import { canonicalize, contentHash } from "../../src/engine/models/model-audit";
import {
  assertSafeBenchmarkSource,
  readActionCompilationCapturedSources,
  type RawBenchmarkSource,
} from "../../src/engine/benchmarks/source-capture";

interface Args {
  database: string;
  executionIds: string[];
  output: string;
  dryRun: boolean;
  force: boolean;
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
    output: path.resolve(".livingworld-benchmarks/source/action-compilation"),
    dryRun: false,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--database") result.database = path.resolve(required(argv, ++index, argument));
    else if (argument === "--execution") result.executionIds.push(required(argv, ++index, argument));
    else if (argument === "--output") result.output = path.resolve(required(argv, ++index, argument));
    else if (argument === "--dry-run") result.dryRun = true;
    else if (argument === "--force") result.force = true;
    else if (argument === "--help") throw new Error("usage: --execution <id> [--execution <id>] [--database <sqlite>] [--output <dir>] [--dry-run] [--force]");
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (result.executionIds.length === 0) throw new Error("provide at least one --execution");
  result.executionIds = [...new Set(result.executionIds)].sort();
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function captureActionCompilationSources(
  database: LocalDatabase,
  executionIds: readonly string[],
): RawBenchmarkSource[] {
  const sources: RawBenchmarkSource[] = [];
  for (const executionId of executionIds) {
    const execution = database.execution(executionId);
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    if (execution.manifest.kind !== "algorithm") {
      throw new Error(`execution is not produced by a world-execution algorithm: ${executionId}`);
    }
    const captured = readActionCompilationCapturedSources(database.executionEvents(executionId));
    if (captured.length === 0) {
      throw new Error(`execution has no schema-v2 model.action_compilation.context.captured evidence: ${executionId}`);
    }
    for (const source of captured) {
      if (source.sourceExecutionId !== executionId ||
        source.captureAlgorithmManifestHash !== execution.manifest.hash ||
        source.captureAlgorithmRef.manifestHash !== execution.manifest.hash ||
        source.worldHash !== execution.worldHash ||
        source.modelCatalogHash !== execution.modelCatalogHash ||
        contentHash(source.fullContext) !== source.fullContextHash ||
        contentHash(source.stateSnapshot) !== source.stateHash ||
        contentHash(source.actions.map((action) => action.id)) !== contentHash(source.actionIds)) {
        throw new Error(`captured provenance does not match execution ${executionId}`);
      }
      assertSafeBenchmarkSource(source);
      sources.push(source);
    }
  }
  const unique = new Map<string, RawBenchmarkSource>();
  for (const source of sources) {
    const key = `${source.sourceExecutionId}:${source.sourceInvocationId}`;
    if (unique.has(key)) throw new Error(`duplicate source invocation: ${key}`);
    unique.set(key, source);
  }
  return [...unique.values()].sort((left, right) =>
    left.sourceExecutionId.localeCompare(right.sourceExecutionId) ||
    left.sourceInvocationId.localeCompare(right.sourceInvocationId));
}

export function main(argv: readonly string[]): number {
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
  const database = new LocalDatabase(args.database, { readOnly: true, heartbeat: false });
  try {
    const sources = captureActionCompilationSources(database, args.executionIds);
    const summary = {
      output: args.output,
      sourceRecords: sources.length,
      executions: args.executionIds,
      providerRequestsDuringCapture: 0,
      networkRequests: 0,
      worldMutations: 0,
      dryRun: args.dryRun,
    };
    if (args.dryRun) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    const manifestFile = path.join(args.output, "manifest.json");
    if (!args.force && existsSync(manifestFile)) {
      throw new Error(`capture output already exists: ${manifestFile} (use --force to replace it)`);
    }
    mkdirSync(args.output, { recursive: true });
    const raw = Buffer.from(sources.map((source) => JSON.stringify(canonicalize(source))).join("\n") + "\n", "utf8");
    const compressed = gzipSync(raw, { level: 9 });
    writeFileSync(path.join(args.output, "sources-000.jsonl.gz"), compressed);
    writeFileSync(manifestFile, `${JSON.stringify({
      schemaVersion: 2,
      kind: "action-compilation-source-capture",
      role: "action-compilation",
      sourceExecutionIds: args.executionIds,
      captureAlgorithmManifestHashes: [...new Set(sources.map((source) => source.captureAlgorithmManifestHash))].sort(),
      initialStateHashes: [...new Set(sources.map((source) => source.stateHash))].sort(),
      records: sources.length,
      file: "sources-000.jsonl.gz",
      rawBytes: raw.byteLength,
      compressedBytes: compressed.byteLength,
      sha256: sha256(compressed),
      capturedAt: new Date().toISOString(),
      offline: { providerRequests: 0, networkRequests: 0, worldMutations: 0 },
    }, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
