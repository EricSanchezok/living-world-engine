import { loadPromptAsset } from "../../prompts";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

export const GLOBAL_MEANS_POOL = "global-means-pool-v1";
const field = "meansSourcePool";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`global means pool: ${message}`); };
type Row = [number, string];
interface Pool { version: typeof GLOBAL_MEANS_POOL; sourceContextHash: string; records: Record<string, unknown>[]; inventories: Row[][] }
const instruction = loadPromptAsset("shared/global-means-pool.md");

/** Share exact records and ordered menus; preserve action-owned selectors and positions. */
export function poolGlobalMeansContext(source: unknown): Record<string, unknown> {
  if (!object(source) || Object.hasOwn(source, field)) return fail("missing source or repeated pool");
  const context = structuredClone(source);
  const pool: Pool = { version: GLOBAL_MEANS_POOL, sourceContextHash: contentHash(source), records: [], inventories: [] };
  const records = new Map<string, number>(), inventories = new Map<string, number>();
  const intern = <T>(value: T, values: T[], ids: Map<string, number>): number => {
    const key = contentHash(value), prior = ids.get(key);
    if (prior !== undefined) return prior;
    const id = values.length; values.push(value); ids.set(key, id); return id;
  };
  let occurrences = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key !== "allowedMeansSources") { visit(child); continue; }
      if (!Array.isArray(child)) return fail("source inventory must be an array");
      const positioned = child.length > 0 && object(child[0]) && Object.hasOwn(child[0], "sourcePosition");
      const rows: Row[] = child.map((row, index) => {
        if (!object(row) || typeof row.sourceSelector !== "string" ||
          Object.hasOwn(row, "sourcePosition") !== positioned || positioned && row.sourcePosition !== index) return fail("unsupported source selector or position");
        const sourceSelector = row.sourceSelector, record = { ...row };
        delete record.sourceSelector; delete record.sourcePosition;
        return [intern(record, pool.records, records), sourceSelector];
      });
      value[key] = { inventory: intern(rows, pool.inventories, inventories), sourcePositions: positioned ? "ordinal" : "absent" };
      occurrences++;
    }
  };
  visit(context);
  if (!occurrences) return fail("no source inventories");
  context[field] = pool;
  // Prove the transform before any provider can consume the pooled context.
  expandGlobalMeansContext(context);
  return context;
}

export function expandGlobalMeansContext(value: unknown): Record<string, unknown> {
  if (!object(value) || !object(value[field])) return fail("missing pool");
  const context = structuredClone(value), pool = context[field] as unknown as Pool;
  delete context[field];
  if (pool.version !== GLOBAL_MEANS_POOL || !Array.isArray(pool.records) || !pool.records.every(object) ||
    !Array.isArray(pool.inventories) || typeof pool.sourceContextHash !== "string") return fail("invalid pool");
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { entry.forEach(visit); return; }
    if (!object(entry)) return;
    for (const [key, child] of Object.entries(entry)) {
      if (key !== "allowedMeansSources") { visit(child); continue; }
      if (!object(child) || Object.keys(child).length !== 2 || !Number.isSafeInteger(child.inventory) ||
        (child.inventory as number) < 0 || !["ordinal", "absent"].includes(String(child.sourcePositions))) return fail("invalid inventory reference");
      const rows = pool.inventories[child.inventory as number];
      if (!Array.isArray(rows)) return fail("unknown inventory");
      entry[key] = rows.map((row, index) => {
        if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 ||
          typeof row[1] !== "string" || !object(pool.records[row[0]])) return fail("invalid inventory row");
        return { ...structuredClone(pool.records[row[0]]), sourceSelector: row[1],
          ...(child.sourcePositions === "ordinal" ? { sourcePosition: index } : {}) };
      });
    }
  };
  visit(context);
  if (contentHash(context) !== pool.sourceContextHash) return fail("source reconstruction changed");
  return context;
}

/** Experimental physical input layout; canonical output processing remains owned by the caller. */
export function globalMeansPoolRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const source = request.context;
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair"].includes(request.schemaName) ||
    !object(source) || !object(source.task) || !object(source.task.resolutionScope) || source.task.resolutionScope.mode !== "global") return request;
  const context = poolGlobalMeansContext(source), binding = contentHash(context), original = contentHash(source);
  return { ...request, context, userPrompt: [request.userPrompt, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${GLOBAL_MEANS_POOL}@${contentHash(instruction).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(context) !== binding || contentHash(source) !== original) return fail("request source changed");
      return request.preprocessOutput?.(raw) ?? { value: raw, symbolRepairs: [] };
    } };
}
