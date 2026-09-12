import { contentHash } from "../../models/model-audit";
import {
  CachedQueryEncoder,
  LOCAL_ENCODER_QUERY_PREFIX,
  type LocalEncoderRuntime,
  type QueryBatchEncodingResult,
} from "../../algorithms/eager-reference/candidate-retrieval/local-encoder";

type Vectors = readonly (readonly number[])[];

/** Memoize the complete encoder input when individual vectors depend on their batch. */
export class CompleteQueryBatchCache extends CachedQueryEncoder {
  private readonly batches = new Map<string, Vectors>();
  private readonly batchPending = new Map<string, Promise<Vectors>>();
  private retainedVectors = 0;

  constructor(encoder: LocalEncoderRuntime, private readonly maxVectors = 256) {
    super(encoder, maxVectors);
  }

  override async encodeBatch(queries: readonly string[]): Promise<QueryBatchEncodingResult> {
    const unique = [...new Set(queries)];
    if (unique.length === 0) return { vectors: [], hits: 0, misses: 0, encoded: 0 };
    const texts = unique.map(query => `${LOCAL_ENCODER_QUERY_PREFIX}${query}`);
    const key = contentHash(texts);
    const cached = this.batches.get(key);
    const existing = this.batchPending.get(key);
    const hit = Boolean(cached || existing);
    let pending: Promise<Vectors>;
    if (cached) {
      this.batches.delete(key);
      this.batches.set(key, cached);
      pending = Promise.resolve(cached);
    } else if (existing) {
      pending = existing;
    } else {
      pending = this.encoder.encodeBatch(texts).then(encoded => {
        if (encoded.length !== unique.length) throw new Error("encoder returned the wrong query embedding count");
        const stable = Object.freeze(encoded.map((vector, index) => {
          if (vector.length !== this.encoder.dimensions || vector.some(value => !Number.isFinite(value))) {
            throw new Error(`query embedding ${index} has invalid dimensions or values`);
          }
          return Object.freeze([...vector]);
        }));
        if (stable.length <= this.maxVectors) {
          while (this.retainedVectors + stable.length > this.maxVectors) {
            const oldest = this.batches.keys().next().value!;
            this.retainedVectors -= this.batches.get(oldest)!.length;
            this.batches.delete(oldest);
          }
          this.batches.set(key, stable);
          this.retainedVectors += stable.length;
        }
        return stable;
      }).finally(() => this.batchPending.delete(key));
      this.batchPending.set(key, pending);
    }
    const vectors = await pending;
    const positions = new Map(unique.map((query, index) => [query, index]));
    return {
      vectors: queries.map(query => vectors[positions.get(query)!]!),
      hits: hit ? unique.length : 0,
      misses: hit ? 0 : unique.length,
      encoded: hit ? 0 : unique.length,
    };
  }

  override get size(): number { return this.retainedVectors; }
}
