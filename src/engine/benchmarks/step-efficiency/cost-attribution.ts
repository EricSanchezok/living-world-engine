import { createHash } from "node:crypto";
import { contentHash } from "../../models/model-audit";
import type { ExperimentPrice, ExperimentUsage } from "../action-compilation/experiment-budget";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../../prompts/repair-layout";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../mechanics/shared-batch-context";
import { expandSharedCatalogPrefix, SHARED_CATALOG_PREFIX_CODEC } from "../../mechanics/shared-catalog-prefix";
import { expandSharedCatalogRecords, SHARED_CATALOG_RECORDS_CODEC } from "../../mechanics/shared-catalog-records";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Decode declared wire layouts before inspecting source-owned repair fields. */
export function recordedLogicalRepair(context: Record<string, unknown>) {
  let state = context.state;
  if (object(state) && state.codec === SHARED_CATALOG_RECORDS_CODEC) state = expandSharedCatalogRecords(state);
  if (object(state) && state.codec === SHARED_CATALOG_PREFIX_CODEC) state = expandSharedCatalogPrefix(state);
  const shared = isSharedBatchContext(state) ? state : null;
  const slots = shared ? expandSharedBatchContexts(shared) : [context];
  const repairedSlots = slots.flatMap((slot, index) => object(slot.repair) && Object.keys(slot.repair).length ? [index] : []);
  const task = object(context.task) ? context.task : undefined;
  const taskRepair = Array.isArray(task?.slots) && task.slots.some(slot => object(slot) && Boolean(slot.issue || slot.previousAttempt));
  const actionCount = (slot: Record<string, unknown>) => object(slot.state) && object(slot.state.actionSet) && Array.isArray(slot.state.actionSet.assigned)
    ? slot.state.actionSet.assigned.length : 0;
  return { shared, slots, detail: {
    logicalRepair: repairedSlots.length > 0 || taskRepair,
    logicalRepairSlots: repairedSlots,
    logicalActionCount: slots.reduce((sum, slot) => sum + actionCount(slot), 0),
    logicalRepairActionCount: repairedSlots.reduce((sum, index) => sum + actionCount(slots[index]!), 0),
    logicalRepairIssueCodes: [...new Set(repairedSlots.flatMap(index => {
      const repair = slots[index]!.repair as Record<string, unknown>;
      return Array.isArray(repair.issues) ? repair.issues.flatMap(issue => object(issue) && typeof issue.code === "string" ? [issue.code] : []) : [];
    }))].sort(),
    logicalLayout: shared?.codec ?? (object(state) && typeof state.codec === "string" ? `unrecognized:${state.codec}` : "direct"),
  } };
}

/** Read both shipped physical feedback layouts. The data may contain the
 * notice as quoted text; only a complete post-schema transport suffix counts. */
export function recordedPhysicalRepair(message: string, context: Record<string, unknown>) {
  const inline = context.batchRepair;
  const marker = `\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n`;
  const position = message.lastIndexOf(marker), schemaPosition = message.indexOf("\nJSON Schema: ");
  let tail: unknown;
  if (position >= 0 && schemaPosition >= 0 && position > schemaPosition) {
    const parsed: unknown = JSON.parse(message.slice(position + marker.length));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("batchRepair" in parsed) || Object.keys(parsed).length !== 1) {
      throw new Error("physical repair tail envelope mismatch");
    }
    tail = parsed.batchRepair;
    if (!tail || typeof tail !== "object" || Array.isArray(tail)) throw new Error("physical repair tail feedback missing");
  }
  if (inline && tail && contentHash(inline) !== contentHash(tail)) throw new Error("physical repair layouts disagree");
  return { physicalRepair: Boolean(inline || tail),
    physicalRepairPlacement: inline ? tail ? "context-and-tail" : "context" : tail ? "tail" : "none" };
}

export function verifyHttpUsage(request: { body: unknown; bodyHash: string },
  response: { raw: string; rawHash: string }, expected: ExperimentUsage): ExperimentUsage {
  if (contentHash(request.body) !== request.bodyHash) throw new Error("request body checksum mismatch");
  if (createHash("sha256").update(response.raw).digest("hex") !== response.rawHash) throw new Error("response checksum mismatch");
  const usage = JSON.parse(response.raw).usage;
  const actual = { input: usage?.prompt_tokens, output: usage?.completion_tokens,
    cacheHit: usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens };
  if (Object.values(actual).some(value => !Number.isSafeInteger(value) || value < 0) || actual.cacheHit > actual.input) {
    throw new Error("missing or inconsistent provider usage");
  }
  if (contentHash(actual) !== contentHash(expected)) throw new Error("provider usage differs from settled ledger");
  return actual;
}

export function attributeTokenCost(usage: ExperimentUsage, price: ExperimentPrice) {
  const hitNanoCny = usage.cacheHit * price.inputHitNanoCnyPerToken;
  const missNanoCny = (usage.input - usage.cacheHit) * price.inputMissNanoCnyPerToken;
  const outputNanoCny = usage.output * price.outputNanoCnyPerToken;
  return { hitNanoCny, missNanoCny, outputNanoCny,
    totalNanoCny: hitNanoCny + missNanoCny + outputNanoCny,
    // A pricing sensitivity bound, never a prediction of attainable cache reuse.
    allInputCachedSensitivityNanoCny: usage.input * price.inputHitNanoCnyPerToken + outputNanoCny };
}

/** Interval unions separate wall time from overlapping HTTP duration sums. */
export function httpConcurrency(intervals: Array<{ startedAt: string; completedAt: string }>) {
  const points = intervals.flatMap(interval => {
    const start = Date.parse(interval.startedAt), end = Date.parse(interval.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("invalid HTTP interval");
    return [{ at: start, delta: 1 }, { at: end, delta: -1 }];
  }).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0, peak = 0, occupiedMs = 0, durationSumMs = 0;
  for (let i = 0; i < points.length; i++) {
    const point = points[i]!;
    const deltaMs = i === 0 ? 0 : point.at - points[i - 1]!.at;
    if (active > 0) occupiedMs += deltaMs;
    durationSumMs += active * deltaMs;
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return { peak, occupiedMs, durationSumMs,
    firstToLastMs: points.length ? points.at(-1)!.at - points[0]!.at : 0 };
}
