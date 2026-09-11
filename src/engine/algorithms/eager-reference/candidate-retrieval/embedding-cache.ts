import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { LocalEncoderRuntime } from "./local-encoder";

export const EMBEDDING_CACHE_SCHEMA_VERSION = 1 as const;

export interface EmbeddingCacheIdentity {
  worldContentHash: string;
  encoderFingerprint: string;
  dimensions: number;
}

export interface PassageEncodingResult {
  vectors: readonly (readonly number[])[];
  hits: number;
  misses: number;
  written: number;
  readMs?: number;
  encodeMs?: number;
}

export interface PassageEmbeddingEncoder {
  readonly encoder: LocalEncoderRuntime;
  readonly encoderFingerprint: string;
  encodePassages(input: {
    worldContentHash: string;
    passages: readonly string[];
    allowWrite: boolean;
  }): Promise<PassageEncodingResult>;
  close(): void;
}

export class EmbeddingCacheIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingCacheIntegrityError";
  }
}

function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function passageHash(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function hashPayload(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid SHA-256 identity: ${value}`);
  return value.slice("sha256:".length);
}

export function embeddingCacheDatabasePath(cacheRoot: string, identity: EmbeddingCacheIdentity): string {
  return path.join(
    path.resolve(cacheRoot),
    "embeddings",
    "action-compilation",
    hashPayload(identity.worldContentHash),
    hashPayload(identity.encoderFingerprint),
    "embeddings-v1.sqlite",
  );
}

function encodeVector(vector: readonly number[], dimensions: number): Buffer {
  if (vector.length !== dimensions) throw new EmbeddingCacheIntegrityError(`embedding dimension mismatch: expected ${dimensions}, got ${vector.length}`);
  const output = Buffer.alloc(dimensions * Float32Array.BYTES_PER_ELEMENT);
  vector.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new EmbeddingCacheIntegrityError(`embedding contains a non-finite value at index ${index}`);
    output.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return output;
}

function decodeVector(bytes: Buffer, dimensions: number): readonly number[] {
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes) {
    throw new EmbeddingCacheIntegrityError(`embedding byte length mismatch: expected ${expectedBytes}, got ${bytes.byteLength}`);
  }
  return Array.from({ length: dimensions }, (_, index) => {
    const value = bytes.readFloatLE(index * Float32Array.BYTES_PER_ELEMENT);
    if (!Number.isFinite(value)) throw new EmbeddingCacheIntegrityError(`cached embedding contains a non-finite value at index ${index}`);
    return value;
  });
}

interface EmbeddingRow {
  passage_hash: string;
  dimensions: number;
  vector_hash: string;
  vector_bytes: Buffer;
}

export class PersistentEmbeddingCache {
  readonly file: string;
  private readonly database: Database.Database;
  private readonly readOnly: boolean;

  constructor(
    cacheRoot: string,
    readonly identity: EmbeddingCacheIdentity,
    options: { readOnly?: boolean } = {},
  ) {
    if (!Number.isSafeInteger(identity.dimensions) || identity.dimensions < 1) throw new Error("embedding dimensions must be a positive integer");
    this.file = embeddingCacheDatabasePath(cacheRoot, identity);
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) mkdirSync(path.dirname(this.file), { recursive: true });
    this.database = new Database(this.file, this.readOnly ? { readonly: true, fileMustExist: true } : undefined);
    if (!this.readOnly) {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
    }
    this.database.pragma("busy_timeout = 5000");
    if (!this.readOnly) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS cache_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS passage_embeddings (
          passage_hash TEXT PRIMARY KEY CHECK (passage_hash GLOB 'sha256:*'),
          dimensions INTEGER NOT NULL CHECK (dimensions > 0),
          vector_hash TEXT NOT NULL CHECK (vector_hash GLOB 'sha256:*'),
          vector_bytes BLOB NOT NULL
        ) STRICT;
      `);
    }
    const expected = new Map<string, string>([
      ["schemaVersion", String(EMBEDDING_CACHE_SCHEMA_VERSION)],
      ["worldContentHash", identity.worldContentHash],
      ["encoderFingerprint", identity.encoderFingerprint],
      ["dimensions", String(identity.dimensions)],
    ]);
    let rows: Array<{ key: string; value: string }>;
    try {
      rows = this.database.prepare("SELECT key, value FROM cache_metadata ORDER BY key").all() as Array<{ key: string; value: string }>;
    } catch (error) {
      this.database.close();
      throw new EmbeddingCacheIntegrityError("embedding cache schema is missing or unreadable", { cause: error });
    }
    if (rows.length === 0) {
      if (this.readOnly) {
        this.database.close();
        throw new EmbeddingCacheIntegrityError("embedding cache metadata is missing");
      }
      const insert = this.database.prepare("INSERT INTO cache_metadata (key, value) VALUES (?, ?)");
      this.database.transaction(() => {
        for (const [key, value] of expected) insert.run(key, value);
      })();
    } else {
      const actual = new Map(rows.map((row) => [row.key, row.value]));
      for (const [key, value] of expected) {
        if (actual.get(key) !== value) {
          this.database.close();
          throw new EmbeddingCacheIntegrityError(`embedding cache metadata mismatch for ${key}`);
        }
      }
      if (actual.size !== expected.size) {
        this.database.close();
        throw new EmbeddingCacheIntegrityError("embedding cache contains unknown metadata fields");
      }
    }
  }

  read(hashes: readonly string[]): ReadonlyMap<string, readonly number[]> {
    const unique = [...new Set(hashes)].sort();
    const output = new Map<string, readonly number[]>();
    const query = this.database.prepare("SELECT passage_hash, dimensions, vector_hash, vector_bytes FROM passage_embeddings WHERE passage_hash = ?");
    for (const hash of unique) {
      const row = query.get(hash) as EmbeddingRow | undefined;
      if (!row) continue;
      if (row.passage_hash !== hash || row.dimensions !== this.identity.dimensions) {
        throw new EmbeddingCacheIntegrityError(`cached embedding metadata mismatch for ${hash}`);
      }
      const bytes = Buffer.from(row.vector_bytes);
      if (sha256Bytes(bytes) !== row.vector_hash) throw new EmbeddingCacheIntegrityError(`cached embedding checksum mismatch for ${hash}`);
      output.set(hash, decodeVector(bytes, this.identity.dimensions));
    }
    return output;
  }

  write(entries: readonly { hash: string; vector: readonly number[] }[]): number {
    if (this.readOnly) throw new EmbeddingCacheIntegrityError("embedding cache is read-only");
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO passage_embeddings (passage_hash, dimensions, vector_hash, vector_bytes)
      VALUES (?, ?, ?, ?)
    `);
    const write = this.database.transaction(() => {
      let inserted = 0;
      for (const entry of [...entries].sort((left, right) => left.hash.localeCompare(right.hash))) {
        const bytes = encodeVector(entry.vector, this.identity.dimensions);
        inserted += insert.run(entry.hash, this.identity.dimensions, sha256Bytes(bytes), bytes).changes;
      }
      return inserted;
    });
    const inserted = write();
    const verified = this.read(entries.map((entry) => entry.hash));
    if (verified.size !== new Set(entries.map((entry) => entry.hash)).size) {
      throw new EmbeddingCacheIntegrityError("embedding cache write did not materialize every passage");
    }
    return inserted;
  }

  count(): number {
    return Number((this.database.prepare("SELECT COUNT(*) AS count FROM passage_embeddings").get() as { count: number }).count);
  }

  verify(): { entries: number; dimensions: number } {
    const hashes = (this.database.prepare("SELECT passage_hash FROM passage_embeddings ORDER BY passage_hash").all() as Array<{ passage_hash: string }>).map((row) => row.passage_hash);
    this.read(hashes);
    return { entries: hashes.length, dimensions: this.identity.dimensions };
  }

  close(): void {
    this.database.close();
  }

  destroy(): void {
    this.close();
    for (const suffix of ["", "-shm", "-wal"]) rmSync(`${this.file}${suffix}`, { force: true });
  }
}

export class CachedPassageEncoder implements PassageEmbeddingEncoder {
  private readonly caches = new Map<string, PersistentEmbeddingCache>();
  private readonly pending = new Map<string, Promise<readonly number[]>>();

  constructor(
    readonly encoder: LocalEncoderRuntime,
    readonly encoderFingerprint: string,
    private readonly cacheRoot: string,
    private readonly readOnly = false,
  ) {}

  private cache(worldContentHash: string): PersistentEmbeddingCache {
    const existing = this.caches.get(worldContentHash);
    if (existing) return existing;
    const cache = new PersistentEmbeddingCache(this.cacheRoot, {
      worldContentHash,
      encoderFingerprint: this.encoderFingerprint,
      dimensions: this.encoder.dimensions,
    }, { readOnly: this.readOnly });
    this.caches.set(worldContentHash, cache);
    return cache;
  }

  async encodePassages(input: {
    worldContentHash: string;
    passages: readonly string[];
    allowWrite: boolean;
  }): Promise<PassageEncodingResult> {
    if (this.readOnly && input.allowWrite) throw new EmbeddingCacheIntegrityError("read-only passage encoder cannot write cache entries");
    const cache = this.cache(input.worldContentHash);
    const uniqueTexts = [...new Set(input.passages)].sort();
    const hashByText = new Map(uniqueTexts.map((text) => [text, passageHash(text)]));
    const readStartedAt = performance.now();
    const cached = cache.read([...hashByText.values()]);
    let readMs = Math.max(0, performance.now() - readStartedAt);
    const misses = uniqueTexts.filter((text) => !cached.has(hashByText.get(text)!));
    if (misses.length > 0 && !input.allowWrite) {
      throw new EmbeddingCacheIntegrityError(`embedding cache is not ready: ${misses.length} passage(s) missing`);
    }
    const encodedByHash = new Map<string, readonly number[]>(cached);
    const ownedMisses: string[] = [];
    const pendingVectors = new Map<string, Promise<readonly number[]>>();
    for (const text of misses) {
      const hash = hashByText.get(text)!;
      const key = `${input.worldContentHash}:${this.encoderFingerprint}:${hash}`;
      const existing = this.pending.get(key);
      if (existing) pendingVectors.set(hash, existing);
      else ownedMisses.push(text);
    }
    let written = 0;
    let encodeMs = 0;
    if (ownedMisses.length > 0) {
      let resolveBatch!: (vectors: readonly (readonly number[])[]) => void;
      let rejectBatch!: (error: unknown) => void;
      const batch = new Promise<readonly (readonly number[])[]>((resolve, reject) => { resolveBatch = resolve; rejectBatch = reject; });
      ownedMisses.forEach((text, index) => {
        const hash = hashByText.get(text)!;
        const key = `${input.worldContentHash}:${this.encoderFingerprint}:${hash}`;
        const pending = batch.then((vectors) => vectors[index] ?? Promise.reject(new Error(`encoder omitted passage ${index}`)));
        // The owning call can fail before it reaches the collection loop below.
        // Attach a rejection observer now so a failed shared batch never leaks an
        // unhandled promise while concurrent callers still receive the error.
        void pending.catch(() => undefined);
        this.pending.set(key, pending);
        pendingVectors.set(hash, pending);
      });
      try {
        const encodeStartedAt = performance.now();
        const vectors = await this.encoder.encodeBatch(ownedMisses);
        encodeMs = Math.max(0, performance.now() - encodeStartedAt);
        if (vectors.length !== ownedMisses.length) throw new EmbeddingCacheIntegrityError("encoder returned the wrong passage count");
        const entries = ownedMisses.map((text, index) => ({ hash: hashByText.get(text)!, vector: vectors[index]! }));
        written = cache.write(entries);
        const persistedReadStartedAt = performance.now();
        const persisted = cache.read(entries.map((entry) => entry.hash));
        readMs += Math.max(0, performance.now() - persistedReadStartedAt);
        const storedVectors = entries.map((entry) => {
          const vector = persisted.get(entry.hash);
          if (!vector) throw new EmbeddingCacheIntegrityError(`persisted embedding is missing: ${entry.hash}`);
          return vector;
        });
        resolveBatch(storedVectors);
      } catch (error) {
        rejectBatch(error);
        throw error;
      } finally {
        for (const text of ownedMisses) this.pending.delete(`${input.worldContentHash}:${this.encoderFingerprint}:${hashByText.get(text)!}`);
      }
    }
    for (const [hash, pending] of pendingVectors) encodedByHash.set(hash, await pending);
    const vectors = input.passages.map((text) => {
      const vector = encodedByHash.get(passageHash(text));
      if (!vector) throw new EmbeddingCacheIntegrityError("encoded passage disappeared from the cache result");
      return vector;
    });
    return {
      vectors,
      hits: uniqueTexts.length - misses.length,
      misses: misses.length,
      written,
      readMs,
      encodeMs,
    };
  }

  close(): void {
    for (const cache of this.caches.values()) cache.close();
    this.caches.clear();
  }
}
