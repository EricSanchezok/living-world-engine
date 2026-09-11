import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  CachedPassageEncoder,
  embeddingCacheDatabasePath,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import {
  discoverLocalEncoderModelDirectory,
  livingWorldCacheRoot,
  loadLocalEncoder,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import {
  relationalRrfEncoderFingerprint,
  R5_RELATIONAL_PASSAGE_SCHEMA_VERSION,
  r5RelationalPassagesForContext,
} from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { retrievalModelAsset } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { actionCompilationPassagesForState } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { loadActionCompilationReferenceDataset } from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { loadWorldScript } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";

type Operation = "warm" | "verify" | "status" | "rebuild";

interface Options {
  operation: Operation;
  cacheRoot: string;
  model: string;
  modelDirectory?: string;
  world?: string;
  instance?: string;
  dataset?: string;
  database: string;
}

interface PassageSource {
  worldContentHash: string;
  passages: readonly string[];
  source: string;
}

function usage(): string {
  return `Usage: retrieval-cache-command <warm|verify|status|rebuild> [options]

Options:
  --world <id-or-path>      Load the bundled world or a world script directory
  --instance <id>           Load the current state from the runtime Ledger
  --dataset <directory>     Load every context from a frozen benchmark
  --database <sqlite>       Runtime Ledger (default: $LIVINGWORLD_DATA_ROOT/livingworld.sqlite)
  --cache-root <directory>  Cache root (default: $LIVINGWORLD_CACHE_ROOT or .livingworld-cache)
  --model <name>            Pinned model (default: multilingual-e5-base)
  --model-dir <directory>   Exact local encoder asset directory
  --help
`;
}

function required(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv: readonly string[]): Options {
  const operation = argv[0] as Operation | undefined;
  if (!operation || !(["warm", "verify", "status", "rebuild"] as const).includes(operation)) {
    throw new Error(usage());
  }
  const options: Options = {
    operation,
    cacheRoot: livingWorldCacheRoot(),
    model: "multilingual-e5-base",
    database: path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23", "livingworld.sqlite"),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--cache-root") options.cacheRoot = path.resolve(required(argv, ++index, argument));
    else if (argument === "--model") options.model = required(argv, ++index, argument);
    else if (argument === "--model-dir") options.modelDirectory = path.resolve(required(argv, ++index, argument));
    else if (argument === "--world") options.world = required(argv, ++index, argument);
    else if (argument === "--instance") options.instance = required(argv, ++index, argument);
    else if (argument === "--dataset") options.dataset = path.resolve(required(argv, ++index, argument));
    else if (argument === "--database") options.database = path.resolve(required(argv, ++index, argument));
    else if (argument === "--help" || argument === "-h") throw new Error(usage());
    else throw new Error(`unknown argument: ${argument}`);
  }
  const sources = [options.world, options.instance, options.dataset].filter(Boolean);
  if (operation !== "status" && sources.length !== 1) {
    throw new Error("provide exactly one of --world, --instance, or --dataset");
  }
  retrievalModelAsset(options.model);
  return options;
}

function contextPassages(context: Readonly<Record<string, unknown>>): readonly string[] {
  return r5RelationalPassagesForContext(context).map((entry) => entry.passage);
}

function resolveWorldDirectory(value: string): string {
  const direct = path.resolve(value);
  if (existsSync(path.join(direct, "script.yaml"))) return direct;
  const bundled = path.resolve("worlds", value, "world");
  if (existsSync(path.join(bundled, "script.yaml"))) return bundled;
  throw new Error(`world script not found: ${value}`);
}

function sourceFromOptions(options: Options): PassageSource {
  if (options.dataset) {
    const dataset = loadActionCompilationReferenceDataset(options.dataset);
    const worldHashes = [...new Set(dataset.cases.map((item) => item.source.worldHash))].sort();
    if (worldHashes.length !== 1) throw new Error("one cache operation may contain only one world content hash");
    const passages = new Set<string>();
    for (const context of dataset.contexts.values()) contextPassages(context.context).forEach((passage) => passages.add(passage));
    return { worldContentHash: worldHashes[0]!, passages: [...passages].sort(), source: `dataset:${dataset.manifest.datasetId}@${dataset.manifest.version}` };
  }
  if (options.instance) {
    const database = new LocalDatabase(options.database, { readOnly: true });
    try {
      const state = database.readInstance(options.instance).document.state;
      return { worldContentHash: state.worldHash, passages: actionCompilationPassagesForState(state), source: `instance:${options.instance}` };
    } finally {
      database.close();
    }
  }
  const directory = resolveWorldDirectory(options.world!);
  const modelCatalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const definition = loadWorldScript(directory, { seed: 1, modelCatalog });
  return {
    worldContentHash: definition.contentHash,
    passages: actionCompilationPassagesForState(definition.initialState),
    source: `world:${definition.id}`,
  };
}

function findCacheDatabases(root: string): readonly string[] {
  const embeddingsRoot = path.join(root, "embeddings");
  if (!existsSync(embeddingsRoot)) return [];
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name === "embeddings-v1.sqlite") output.push(absolute);
    }
  };
  visit(embeddingsRoot);
  return output;
}

function cacheStatus(cacheRoot: string): readonly Record<string, unknown>[] {
  return findCacheDatabases(cacheRoot).map((file) => {
    const database = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const metadata = Object.fromEntries((database.prepare("SELECT key, value FROM cache_metadata ORDER BY key").all() as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]));
      const count = Number((database.prepare("SELECT COUNT(*) AS count FROM passage_embeddings").get() as { count: number }).count);
      return { file, bytes: statSync(file).size, entries: count, metadata };
    } finally {
      database.close();
    }
  });
}

async function execute(options: Options): Promise<Record<string, unknown>> {
  if (options.operation === "status") {
    const caches = cacheStatus(options.cacheRoot);
    return { operation: "status", cacheRoot: options.cacheRoot, cacheCount: caches.length, caches };
  }
  const source = sourceFromOptions(options);
  const asset = retrievalModelAsset(options.model);
  const modelDirectory = options.modelDirectory ?? discoverLocalEncoderModelDirectory(options.cacheRoot, asset.name);
  const encoder = await loadLocalEncoder({
    modelDirectory,
    modelId: asset.modelId,
    expectedHash: asset.directorySha256,
  });
  const encoderFingerprint = relationalRrfEncoderFingerprint(encoder, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION);
  if (encoderFingerprint !== asset.encoderFingerprint) {
    throw new Error(`retrieval encoder fingerprint drift: expected ${asset.encoderFingerprint}, got ${encoderFingerprint}`);
  }
  const identity = { worldContentHash: source.worldContentHash, encoderFingerprint, dimensions: encoder.dimensions };
  const file = embeddingCacheDatabasePath(options.cacheRoot, identity);
  if (options.operation === "rebuild") {
    for (const suffix of ["", "-shm", "-wal"]) rmSync(`${file}${suffix}`, { force: true });
  }
  const cachedEncoder = new CachedPassageEncoder(
    encoder,
    encoderFingerprint,
    options.cacheRoot,
    options.operation === "verify",
  );
  try {
    const result = await cachedEncoder.encodePassages({
      worldContentHash: source.worldContentHash,
      passages: source.passages,
      allowWrite: options.operation !== "verify",
    });
    return {
      operation: options.operation,
      source: source.source,
      cacheRoot: options.cacheRoot,
      database: file,
      worldContentHash: source.worldContentHash,
      encoderFingerprint,
      modelHash: encoder.modelHash,
      modelRevision: asset.revision,
      dimensions: encoder.dimensions,
      passages: source.passages.length,
      hits: result.hits,
      misses: result.misses,
      written: result.written,
      ready: result.misses === 0 || options.operation !== "verify",
    };
  } finally {
    cachedEncoder.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    process.stdout.write(`${JSON.stringify(await execute(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      process.stdout.write(message);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
