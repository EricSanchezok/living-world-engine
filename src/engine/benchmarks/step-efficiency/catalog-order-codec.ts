import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { recordedContext } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";

const codec = "shared-json-catalog-order-v1";
const compactSchema = z.strictObject({
  codec: z.literal(codec), shared: z.record(z.string(), z.unknown()),
  catalogHandles: z.array(z.string()), catalogOrders: z.array(z.array(z.number().int().nonnegative())),
  slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), delta: z.record(z.string(), z.unknown()),
    contextHash: z.string(), catalogOrderId: z.number().int().nonnegative().optional() })),
});
type CompactBatch = z.infer<typeof compactSchema>;

/** Only the ordered handle lists are dictionary encoded; candidate records,
 * per-slot deltas and their complete original envelope hashes remain intact. */
export function compactCatalogOrders(batch: SharedBatchContext): CompactBatch {
  expandSharedBatchContexts(batch);
  const catalogHandles = [...new Set(batch.slots.flatMap((slot) => slot.catalogCandidateOrder ?? []))].sort();
  const handles = new Map(catalogHandles.map((handle, index) => [handle, index]));
  const catalogOrders: number[][] = [], orderIds = new Map<string, number>();
  const slots = batch.slots.map(({ catalogCandidateOrder, ...slot }) => {
    if (catalogCandidateOrder === undefined) return structuredClone(slot);
    const order = catalogCandidateOrder.map((handle) => handles.get(handle)!);
    const key = JSON.stringify(order);
    if (!orderIds.has(key)) { orderIds.set(key, catalogOrders.length);catalogOrders.push(order); }
    return { ...structuredClone(slot), catalogOrderId: orderIds.get(key)! };
  });
  const result: CompactBatch = { codec, shared: structuredClone(batch.shared), catalogHandles, catalogOrders, slots };
  if (contentHash(expandCatalogOrders(result)) !== contentHash(batch)) throw new Error("catalog order encoding changed source batch");
  return result;
}

/** Reject malformed dictionaries before the existing full envelope binding check. */
export function expandCatalogOrders(value: unknown): SharedBatchContext {
  const compact = compactSchema.parse(value);
  if (new Set(compact.catalogHandles).size !== compact.catalogHandles.length) throw new Error("duplicate catalog dictionary handle");
  for (const order of compact.catalogOrders) {
    if (new Set(order).size !== order.length || order.some((i) => i >= compact.catalogHandles.length)) throw new Error("invalid catalog order permutation");
  }
  const batch = { codec: "shared-json-v2" as const, shared: compact.shared,
    slots: compact.slots.map(({ catalogOrderId, ...slot }) => {
      if (catalogOrderId === undefined) return slot;
      const order = compact.catalogOrders[catalogOrderId];
      if (!order) throw new Error("missing catalog order dictionary entry");
      return { ...slot, catalogCandidateOrder: order.map((i) => compact.catalogHandles[i]!) };
    }) } as SharedBatchContext;
  expandSharedBatchContexts(batch);
  return batch;
}

const notice = "Input codec shared-json-catalog-order-v1 is a lossless encoding of shared-json-v2. For each slot, catalogOrderId selects catalogOrders[catalogOrderId]; each integer in that list selects the exact handle in catalogHandles, in the original order. This reconstructs that slot's catalogCandidateOrder. Merge only that slot's delta with shared as before. The global handle dictionary records spellings only: it does not grant any slot access to another slot's candidates. All candidate records, scope, actions, state and output schema are unchanged. Output the original reference strings required by the schema, never dictionary integers.";

export function catalogOrderBody(source: TemporalProbeBody) {
  if (source.thinking.type !== "disabled") throw new Error("catalog order experiment keeps thinking disabled");
  const body = structuredClone(source), message = body.messages[1]!.content;
  const context = recordedContext(message), batch = context.value.state as SharedBatchContext;
  const compact = compactCatalogOrders(batch);
  const next = { ...context.value, state: compact };
  const restored = { ...next, state: expandCatalogOrders(compact) };
  if (contentHash(restored) !== contentHash(context.value)) throw new Error("context restoration changed source");
  body.messages[1]!.content = `${message.slice(0, context.start)}${JSON.stringify(next)}${message.slice(context.end)}\n\n${notice}`;
  return { body, sourceContextHash: contentHash(context.value), restoredContextHash: contentHash(restored),
    beforeBytes: Buffer.byteLength(context.text), afterBytes: Buffer.byteLength(JSON.stringify(next)),
    handles: compact.catalogHandles.length, uniqueOrders: compact.catalogOrders.length, slots: compact.slots.length };
}
