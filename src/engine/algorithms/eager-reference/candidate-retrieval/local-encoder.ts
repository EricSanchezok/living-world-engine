import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { contentHash } from "../../../models/model-audit";
import { pathToFileURL } from "node:url";
import { createEncoderWorker } from "./encoder-worker";
import { inspectFullPrecisionEncoder } from "./encoder-graph";

export const MULTILINGUAL_E5_SMALL_MODEL_ID = "intfloat/multilingual-e5-small" as const;
export const TRANSFORMERS_LIBRARY_PACKAGE = "@huggingface/transformers" as const;
export const LOCAL_ENCODER_MAX_BATCH_SIZE = 128 as const;
export const LOCAL_ENCODER_MAX_TOKENS = 128 as const;
export const LOCAL_ENCODER_QUERY_PREFIX = "query: " as const;
export const LOCAL_ENCODER_PASSAGE_PREFIX = "passage: " as const;

/** Keep resolution indirect: Next/Turbopack rewrites direct require.resolve calls in Route Handler bundles. */
export function resolveInstalledModule(specifier: string, workspaceRoot = process.cwd()): string {
  const runtimeRequire = createRequire(path.join(path.resolve(workspaceRoot), "package.json"));
  const resolver = runtimeRequire.resolve;
  const resolved = Reflect.apply(resolver, runtimeRequire, [specifier]) as unknown;
  if (typeof resolved !== "string" || !path.isAbsolute(resolved)) {
    throw new Error(`installed module did not resolve to an absolute path: ${specifier}`);
  }
  return resolved;
}

export function livingWorldCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(/* turbopackIgnore: true */ env.LIVINGWORLD_CACHE_ROOT ?? ".livingworld-cache");
}

export function discoverLocalEncoderModelDirectory(
  cacheRoot = livingWorldCacheRoot(),
  modelName = "multilingual-e5-small",
): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(modelName)) throw new Error(`invalid local encoder model name: ${modelName}`);
  const root = path.join(path.resolve(cacheRoot), "models", modelName);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`local encoder model root is missing: ${root}`);
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .sort();
  if (candidates.length !== 1) throw new Error(`local encoder model root must contain exactly one hashed asset directory: ${root}`);
  const selected = candidates[0]!;
  const actual = hashLocalModelDirectory(selected).slice("sha256:".length);
  if (path.basename(selected) !== actual) throw new Error(`local encoder asset directory name does not match its content hash: ${selected}`);
  return selected;
}

export interface LocalEncoderRuntime {
  readonly modelId: string;
  readonly modelHash: string;
  readonly dimensions: number;
  readonly libraryVersion?: string;
  readonly libraryHash?: string;
  readonly inferenceContract?: "explicit-fp32-128-v2";
  dispose?(): Promise<void>;
  encodeBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface LocalEncoderAssetOptions {
  modelDirectory: string;
  modelId?: string;
  expectedHash?: string;
  explicitFp32OnnxSha256?: string;
}

export interface QueryEncodingResult {
  vector: readonly number[];
  cacheHit: boolean;
}

export interface QueryBatchEncodingResult {
  vectors: readonly (readonly number[])[];
  hits: number;
  misses: number;
  encoded: number;
}

/** Process-local bounded cache for dynamic slot queries. */
export class CachedQueryEncoder {
  private readonly values = new Map<string, readonly number[]>();
  private readonly pending = new Map<string, Promise<readonly number[]>>();

  constructor(
    readonly encoder: LocalEncoderRuntime,
    private readonly maxEntries = 256,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("query cache maxEntries must be a positive integer");
  }

  private key(query: string): string {
    return createHash("sha256").update(`${LOCAL_ENCODER_QUERY_PREFIX}${query}`, "utf8").digest("hex");
  }

  async encode(query: string): Promise<QueryEncodingResult> {
    const encoded = await this.encodeBatch([query]);
    const vector = encoded.vectors[0];
    if (!vector) throw new Error("encoder omitted the query embedding");
    return { vector, cacheHit: encoded.hits === 1 };
  }

  async encodeBatch(queries: readonly string[]): Promise<QueryBatchEncodingResult> {
    if (queries.length === 0) return { vectors: [], hits: 0, misses: 0, encoded: 0 };
    const uniqueQueries = [...new Set(queries)];
    const queryByKey = new Map(uniqueQueries.map((query) => [this.key(query), query]));
    const vectorsByKey = new Map<string, readonly number[]>();
    const pendingByKey = new Map<string, Promise<readonly number[]>>();
    const misses: Array<{ key: string; query: string }> = [];

    for (const [key, query] of queryByKey) {
      const cached = this.values.get(key);
      if (cached) {
        this.values.delete(key);
        this.values.set(key, cached);
        vectorsByKey.set(key, cached);
        continue;
      }
      const inflight = this.pending.get(key);
      if (inflight) pendingByKey.set(key, inflight);
      else misses.push({ key, query });
    }

    if (misses.length > 0) {
      let resolveBatch!: (vectors: readonly (readonly number[])[]) => void;
      let rejectBatch!: (error: unknown) => void;
      const batch = new Promise<readonly (readonly number[])[]>((resolve, reject) => {
        resolveBatch = resolve;
        rejectBatch = reject;
      });
      misses.forEach(({ key }, index) => {
        const pending = batch.then((vectors) => {
          const vector = vectors[index];
          if (!vector) throw new Error(`encoder omitted query embedding ${index}`);
          return vector;
        });
        void pending.catch(() => undefined);
        this.pending.set(key, pending);
        pendingByKey.set(key, pending);
      });

      try {
        const encoded = await this.encoder.encodeBatch(
          misses.map(({ query }) => `${LOCAL_ENCODER_QUERY_PREFIX}${query}`),
        );
        if (encoded.length !== misses.length) throw new Error("encoder returned the wrong query embedding count");
        const stable = encoded.map((vector, index) => {
          if (vector.length !== this.encoder.dimensions) {
            throw new Error(`query embedding ${index} has the wrong dimension`);
          }
          if (vector.some((value) => !Number.isFinite(value))) {
            throw new Error(`query embedding ${index} contains a non-finite value`);
          }
          return Object.freeze([...vector]);
        });
        stable.forEach((vector, index) => {
          this.values.set(misses[index]!.key, vector);
          while (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
        });
        resolveBatch(stable);
      } catch (error) {
        rejectBatch(error);
        throw error;
      } finally {
        misses.forEach(({ key }) => this.pending.delete(key));
      }
    }

    try {
      for (const [key, pending] of pendingByKey) vectorsByKey.set(key, await pending);
      return {
        vectors: queries.map((query) => {
          const vector = vectorsByKey.get(this.key(query));
          if (!vector) throw new Error("encoded query disappeared from the batch result");
          return vector;
        }),
        hits: uniqueQueries.length - misses.length,
        misses: misses.length,
        encoded: misses.length,
      };
    } catch (error) {
      throw error;
    }
  }

  get size(): number {
    return this.values.size;
  }
}

function files(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".cache") continue;
        visit(absolute);
      } else if (entry.isFile()) output.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return output;
}

function packageRoot(): string {
  const entry = resolveInstalledModule(TRANSFORMERS_LIBRARY_PACKAGE);
  let directory = path.dirname(entry);
  while (path.basename(directory) !== "transformers" || path.basename(path.dirname(directory)) !== "@huggingface") {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`cannot locate ${TRANSFORMERS_LIBRARY_PACKAGE} package root`);
    directory = parent;
  }
  return directory;
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const relative of files(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, relative)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function libraryMetadata(): { version: string; hash: string } {
  const transformersRoot = packageRoot();
  const transformersPackage = JSON.parse(readFileSync(path.join(transformersRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof transformersPackage.version !== "string" || transformersPackage.version.length === 0) {
    throw new Error(`${TRANSFORMERS_LIBRARY_PACKAGE} package version is missing`);
  }
  const runtimeRoot = path.dirname(resolveInstalledModule("onnxruntime-node/package.json"));
  const runtimePackage = JSON.parse(readFileSync(path.join(runtimeRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof runtimePackage.version !== "string" || runtimePackage.version.length === 0) {
    throw new Error("onnxruntime-node package version is missing");
  }
  const components = {
    transformers: {
      version: transformersPackage.version,
      hash: hashDirectory(transformersRoot),
    },
    onnxRuntimeNode: {
      version: runtimePackage.version,
      hash: hashDirectory(runtimeRoot),
    },
  };
  return {
    version: `${TRANSFORMERS_LIBRARY_PACKAGE}@${transformersPackage.version};onnxruntime-node@${runtimePackage.version}`,
    hash: `sha256:${contentHash(components)}`,
  };
}

function configuredDimensions(modelDirectory: string): number {
  const config = JSON.parse(readFileSync(path.join(modelDirectory, "config.json"), "utf8")) as {
    hidden_size?: unknown;
    d_model?: unknown;
  };
  const value = config.hidden_size ?? config.d_model;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("local encoder config does not declare a positive embedding dimension");
  }
  return Number(value);
}

export function hashLocalModelDirectory(modelDirectory: string): string {
  const root = path.resolve(modelDirectory);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`local encoder model directory is missing: ${root}`);
  return hashDirectory(root);
}

export function localEncoderFingerprint(encoder: LocalEncoderRuntime, passageSchemaVersion: number): string {
  if (!Number.isSafeInteger(passageSchemaVersion) || passageSchemaVersion < 1) {
    throw new Error("passage schema version must be a positive integer");
  }
  return `sha256:${contentHash({
    modelId: encoder.modelId,
    modelHash: encoder.modelHash,
    dimensions: encoder.dimensions,
    libraryVersion: encoder.libraryVersion ?? null,
    libraryHash: encoder.libraryHash ?? null,
    queryPrefix: LOCAL_ENCODER_QUERY_PREFIX,
    passagePrefix: LOCAL_ENCODER_PASSAGE_PREFIX,
    pooling: "mean",
    normalize: true,
    truncation: true,
    maxTokens: LOCAL_ENCODER_MAX_TOKENS,
    passageSchemaVersion,
    ...(encoder.inferenceContract ? { inferenceContract: encoder.inferenceContract } : {}),
  })}`;
}

export async function loadLocalEncoder(options: LocalEncoderAssetOptions): Promise<LocalEncoderRuntime> {
  const modelDirectory = path.resolve(options.modelDirectory);
  const modelId = options.modelId ?? MULTILINGUAL_E5_SMALL_MODEL_ID;
  const modelHash = hashLocalModelDirectory(modelDirectory);
  if (options.expectedHash && options.expectedHash !== modelHash) {
    throw new Error(`local encoder model hash mismatch: expected ${options.expectedHash}, got ${modelHash}`);
  }
  const dimensions = configuredDimensions(modelDirectory);
  if (options.explicitFp32OnnxSha256) inspectFullPrecisionEncoder(path.join(modelDirectory, "onnx/model.onnx"), options.explicitFp32OnnxSha256);
  const library = libraryMetadata();
  const worker = await createEncoderWorker({
    moduleUrl: pathToFileURL(resolveInstalledModule(TRANSFORMERS_LIBRARY_PACKAGE)).href,
    modelDirectory,
    dimensions,
    maxBatchSize: LOCAL_ENCODER_MAX_BATCH_SIZE,
    maxTokens: LOCAL_ENCODER_MAX_TOKENS,
    explicitFp32: Boolean(options.explicitFp32OnnxSha256),
  });
  return {
    modelId,
    modelHash,
    dimensions,
    libraryVersion: library.version,
    libraryHash: library.hash,
    ...(options.explicitFp32OnnxSha256 ? { inferenceContract: "explicit-fp32-128-v2" as const } : {}),
    ...worker,
  };
}
