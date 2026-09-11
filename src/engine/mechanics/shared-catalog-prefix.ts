import { ModelConfigurationError } from "../models/model-provider";
import { contentHash } from "../models/model-audit";
import { expandSharedBatchContexts, SHARED_BATCH_ORDER_CODEC, type SharedBatchContext } from "./shared-batch-context";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (): never => { throw new ModelConfigurationError("shared catalog prefix: invalid source or binding"); };
export const SHARED_CATALOG_PREFIX_CODEC = "shared-json-v3-prefix-v1";

/** Store only an exact common prefix; every slot's suffix and candidate order remain explicit. */
export function compactSharedCatalogPrefix(value: unknown): ObjectValue {
  if (!object(value) || value.codec !== SHARED_BATCH_ORDER_CODEC || !object(value.catalogOrders) ||
    Object.hasOwn(value, "catalogOrderPrefix") || Object.hasOwn(value, "catalogOrderSuffixes")) return fail();
  expandSharedBatchContexts(value as unknown as SharedBatchContext);
  const orders = Object.values(value.catalogOrders) as string[][];
  let count = orders[0]?.length ?? 0;
  for (const order of orders.slice(1)) {
    count = Math.min(count, order.length);
    let equal = 0;
    while (equal < count && order[equal] === orders[0]![equal]) equal++;
    count = equal;
  }
  const copy = structuredClone(value);
  delete copy.catalogOrders;
  return { ...copy, codec: SHARED_CATALOG_PREFIX_CODEC, catalogOrderPrefix: orders[0]?.slice(0, count) ?? [],
    catalogOrderSuffixes: Object.fromEntries(Object.entries(value.catalogOrders).map(([id, order]) => [id, (order as string[]).slice(count)])) };
}

export function expandSharedCatalogPrefix(value: unknown): SharedBatchContext {
  if (!object(value) || value.codec !== SHARED_CATALOG_PREFIX_CODEC || Object.hasOwn(value, "catalogOrders") ||
    !Array.isArray(value.catalogOrderPrefix) || value.catalogOrderPrefix.some(handle => typeof handle !== "string") ||
    !object(value.catalogOrderSuffixes) || Object.values(value.catalogOrderSuffixes).some(suffix =>
      !Array.isArray(suffix) || suffix.some(handle => typeof handle !== "string"))) return fail();
  const { catalogOrderPrefix, catalogOrderSuffixes, ...copy } = structuredClone(value);
  const restored = { ...copy, codec: SHARED_BATCH_ORDER_CODEC, catalogOrders: Object.fromEntries(
    Object.entries(catalogOrderSuffixes as ObjectValue).map(([id, suffix]) => [id, [...catalogOrderPrefix as string[], ...suffix as string[]]])) } as unknown as SharedBatchContext;
  expandSharedBatchContexts(restored);
  if (contentHash(compactSharedCatalogPrefix(restored)) !== contentHash(value)) return fail();
  return restored;
}
