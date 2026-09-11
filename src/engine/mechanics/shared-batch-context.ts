import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { canonicalize, contentHash } from "../models/model-audit";
import { assertJsonValue, type JsonObject, type JsonValue } from "../runtime/json";

export const SHARED_BATCH_CONTEXT_CODEC = "shared-json-v2" as const;
export const SHARED_BATCH_ORDER_CODEC = "shared-json-v3" as const;

export interface SharedBatchContext {
  codec: typeof SHARED_BATCH_CONTEXT_CODEC | typeof SHARED_BATCH_ORDER_CODEC;
  shared: JsonObject;
  catalogOrders?: Record<string, string[]>;
  slots: Array<{ slot: number; delta: JsonObject; contextHash: string; catalogCandidateOrder?: string[]; catalogOrderRef?: string }>;
}

const EXPANSION_CACHE_BYTES = 32 * 1024 * 1024;
interface ExpansionCache { entries: Map<string, Buffer>; bytes: number; limit: number }
let expansionCache: ExpansionCache | undefined;

/** Reuse only within synchronous request construction. In particular, returning
 * a Promise ends the scope immediately; no cache survives an HTTP wait.
 * @see ../../../docs/decisions/0166-bound-shared-context-expansion-reuse.md */
export function withSharedContextReuse<T>(build: () => T, maxBytes = EXPANSION_CACHE_BYTES): T {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid shared context cache budget");
  const previous = expansionCache;
  expansionCache = maxBytes ? { entries: new Map(), bytes: 0, limit: maxBytes } : undefined;
  try { return build(); } finally { expansionCache = previous; }
}

function object(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function common(values: readonly JsonObject[]): JsonObject {
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, value] of Object.entries(values[0]!)) {
    if (!values.every((entry) => Object.hasOwn(entry, key))) continue;
    const peers = values.map((entry) => entry[key]!);
    const hash = contentHash(value);
    if (peers.every((entry) => contentHash(entry) === hash)) {
      entries.push([key, structuredClone(value)]);
    } else if (peers.every(object)) {
      const nested = common(peers);
      if (Object.keys(nested).length > 0) entries.push([key, nested]);
    }
  }
  return Object.fromEntries(entries);
}

function difference(value: JsonObject, shared: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    if (!Object.hasOwn(shared, key)) return [[key, structuredClone(entry)]];
    if (contentHash(entry) === contentHash(shared[key])) return [];
    return [[key, object(entry) && object(shared[key])
      ? difference(entry, shared[key]) : structuredClone(entry)]];
  }));
}

function merge(shared: JsonObject, delta: JsonObject): JsonObject {
  return Object.fromEntries([
    ...Object.entries(shared).filter(([key]) => !Object.hasOwn(delta, key)).map(([key, value]) => [key, structuredClone(value)]),
    ...Object.entries(delta).map(([key, value]) => [key,
      Object.hasOwn(shared, key) && object(value) && object(shared[key])
        ? merge(shared[key], value) : structuredClone(value)]),
  ]);
}

/** Catalog handles provide lossless dictionary keys; other arrays remain indivisible. */
function encodeCatalog(value: JsonObject): { value: JsonObject; catalogCandidateOrder?: string[] } {
  const catalog = value.referenceCatalog;
  if (!object(catalog) || !Array.isArray(catalog.candidates)) return { value };
  const candidates = catalog.candidates;
  if (!candidates.every((candidate) => object(candidate) && typeof candidate.handle === "string")) return { value };
  const order = candidates.map((candidate) => (candidate as JsonObject).handle as string);
  if (new Set(order).size !== order.length) throw new Error("reference catalog has duplicate handles");
  return { value: { ...value, referenceCatalog: { ...catalog,
    candidates: Object.fromEntries(candidates.map((candidate, index) => [order[index]!, candidate])) } },
    catalogCandidateOrder: order };
}

/** Factor exactly equal JSON values after an ordered, reversible catalog encoding. */
export function factorSharedBatchContexts(contexts: readonly unknown[], codec: SharedBatchContext["codec"] = SHARED_BATCH_CONTEXT_CODEC): SharedBatchContext {
  if (codec !== SHARED_BATCH_CONTEXT_CODEC && codec !== SHARED_BATCH_ORDER_CODEC) throw new Error("unknown shared context codec");
  if (contexts.length < 2) throw new Error("shared context batching requires at least two slots");
  const values = contexts.map((context) => {
    // Use the same JSON serialization boundary as the gateway. Optional
    // undefined object members are absent on the actual wire.
    const value: unknown = JSON.parse(JSON.stringify(canonicalize(context)));
    assertJsonValue(value, "shared batch slot");
    if (!object(value)) throw new Error("shared context slot must be a JSON object");
    return value;
  });
  const encoded = values.map(encodeCatalog);
  const shared = common(encoded.map((entry) => entry.value));
  const catalogOrders: Record<string, string[]> = {}, orderIds = new Map<string, string>();
  const orderReference = (order: string[]) => {
    const hash = contentHash(order), prior = orderIds.get(hash);
    if (prior) return prior;
    const id = `o${orderIds.size}`;
    orderIds.set(hash, id); catalogOrders[id] = order;
    return id;
  };
  const result: SharedBatchContext = { codec, shared,
    slots: encoded.map((entry, slot) => ({ slot, delta: difference(entry.value, shared), contextHash: contentHash(values[slot]),
      ...(entry.catalogCandidateOrder ? codec === SHARED_BATCH_ORDER_CODEC
        ? { catalogOrderRef: orderReference(entry.catalogCandidateOrder) } : { catalogCandidateOrder: entry.catalogCandidateOrder } : {}) })),
    ...(codec === SHARED_BATCH_ORDER_CODEC ? { catalogOrders } : {}) };
  expandSharedBatchContexts(result);
  return result;
}

/** The hash is checked against the complete original logical envelope. */
export function expandSharedBatchContexts(batch: SharedBatchContext): JsonObject[] {
  const cache = expansionCache;
  if (!cache) return expandContext(batch);
  // Binary serialization retains property order, absent/undefined members and
  // array order. Clone first so native array storage differences introduced by
  // earlier adapters do not cause avoidable misses. Equal values may still
  // serialize differently; that costs reuse, never a binding check.
  const key = createHash("sha256").update(serialize(structuredClone(batch))).digest("hex");
  const prior = cache.entries.get(key);
  if (prior) {
    cache.entries.delete(key);
    cache.entries.set(key, prior);
    return deserialize(prior) as JsonObject[];
  }
  const result = expandContext(batch);
  // Store owned bytes before exposing the mutable result. Every hit also owns
  // its objects, including independent copies of shared values in each slot.
  const bytes = serialize(result);
  if (bytes.length <= cache.limit) {
    while (cache.bytes + bytes.length > cache.limit || cache.entries.size >= 64) {
      const oldest = cache.entries.keys().next().value!;
      cache.bytes -= cache.entries.get(oldest)!.length;
      cache.entries.delete(oldest);
    }
    cache.entries.set(key, bytes);
    cache.bytes += bytes.length;
  }
  return result;
}

function expandContext(batch: SharedBatchContext): JsonObject[] {
  if (batch.codec !== SHARED_BATCH_CONTEXT_CODEC && batch.codec !== SHARED_BATCH_ORDER_CODEC) throw new Error("unknown shared context codec");
  if (batch.codec === SHARED_BATCH_CONTEXT_CODEC && (batch.catalogOrders !== undefined || batch.slots.some(slot => slot.catalogOrderRef !== undefined))) {
    throw new Error("shared context codec and catalog order layout disagree");
  }
  if (batch.codec === SHARED_BATCH_ORDER_CODEC) {
    if (!batch.catalogOrders || typeof batch.catalogOrders !== "object" || Array.isArray(batch.catalogOrders) ||
      Object.values(batch.catalogOrders).some(order => !Array.isArray(order) || order.some(handle => typeof handle !== "string")) ||
      batch.slots.some(slot => slot.catalogCandidateOrder !== undefined || (slot.catalogOrderRef !== undefined && typeof slot.catalogOrderRef !== "string"))) {
      throw new Error("invalid shared catalog order dictionary");
    }
    const used = new Set(batch.slots.flatMap(slot => slot.catalogOrderRef === undefined ? [] : [slot.catalogOrderRef]));
    if (Object.keys(batch.catalogOrders).length !== used.size || [...used].some(id => !Object.hasOwn(batch.catalogOrders!, id))) {
      throw new Error("shared catalog order dictionary coverage changed");
    }
  }
  return batch.slots.map((slot, index) => {
    if (slot.slot !== index) throw new Error("shared context slot order or coverage changed");
    let value = merge(batch.shared, slot.delta);
    const order = batch.codec === SHARED_BATCH_ORDER_CODEC
      ? slot.catalogOrderRef === undefined ? undefined : batch.catalogOrders![slot.catalogOrderRef]
      : slot.catalogCandidateOrder;
    if (order) {
      const catalog = value.referenceCatalog;
      const candidates = object(catalog) ? catalog.candidates : undefined;
      if (!object(catalog) || !object(candidates) || new Set(order).size !== order.length ||
        Object.keys(candidates).length !== order.length || order.some((handle) => !Object.hasOwn(candidates, handle))) {
        throw new Error("shared catalog order or coverage changed");
      }
      value = { ...value, referenceCatalog: { ...catalog, candidates: order.map((handle) => candidates[handle]!) } };
    }
    if (contentHash(value) !== slot.contextHash) throw new Error("shared context slot binding changed");
    return value;
  });
}

export function isSharedBatchContext(value: unknown): value is SharedBatchContext {
  return Boolean(value && typeof value === "object" && "codec" in value &&
    (value.codec === SHARED_BATCH_CONTEXT_CODEC || value.codec === SHARED_BATCH_ORDER_CODEC));
}
