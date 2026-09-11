import { canonicalize, contentHash } from "../models/model-audit";
import { assertJsonValue, type JsonObject, type JsonValue } from "../runtime/json";

export const SHARED_REPAIR_HANDLES_CODEC = "shared-repair-handles-v2";
export const SHARED_REPAIR_HANDLES_NOTICE = "For a repair issue with allowedHandlesRef, use the exact ordered list at repairHandleSets.sets[allowedHandlesRef] as that issue's allowedHandles. This shares identical error hints across slots; each issue path, previous attempt, and slot's displayed candidate scope remains unchanged. Shared error hints do not add candidates to a slot.";

type MutableJsonObject = Record<string, JsonValue>;

function object(value: JsonValue | undefined): value is MutableJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonContext(value: unknown): MutableJsonObject {
  const normalized: unknown = JSON.parse(JSON.stringify(canonicalize(value)));
  assertJsonValue(normalized, "repair context");
  if (!object(normalized)) throw new Error("repair context must be an object");
  return normalized;
}

function issues(context: JsonObject): MutableJsonObject[] {
  if (!object(context.task) || !Array.isArray(context.task.slots)) return [];
  return context.task.slots.flatMap((slot) => object(slot) && Array.isArray(slot.issues) ? slot.issues.filter(object) : []);
}

/** Share only identical ordered lists in the original per-slot repair issues.
 * All other information survives an exact context-hash round trip. */
export function factorSharedRepairHandles(input: unknown): JsonObject {
  const original = jsonContext(input);
  if (Object.hasOwn(original, "repairHandleSets")) throw new Error("repair dictionary field already exists");
  const counts = new Map<string, number>();
  for (const issue of issues(original)) {
    if (Object.hasOwn(issue, "allowedHandlesRef")) throw new Error("repair issue already has a dictionary reference");
    if (!Array.isArray(issue.allowedHandles) || !issue.allowedHandles.length ||
      !issue.allowedHandles.every((handle) => typeof handle === "string")) continue;
    const key = contentHash(issue.allowedHandles);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (![...counts.values()].some((count) => count > 1)) return original;
  const encoded = structuredClone(original);
  const sets: MutableJsonObject = {};
  for (const issue of issues(encoded)) {
    if (!Array.isArray(issue.allowedHandles)) continue;
    const key = contentHash(issue.allowedHandles);
    if ((counts.get(key) ?? 0) < 2) continue;
    sets[key] = issue.allowedHandles;
    delete issue.allowedHandles;
    issue.allowedHandlesRef = key;
  }
  encoded.repairHandleSets = { codec: SHARED_REPAIR_HANDLES_CODEC, contextHash: contentHash(original), sets };
  expandSharedRepairHandles(encoded);
  return JSON.stringify(encoded).length < JSON.stringify(original).length ? encoded : original;
}

export function expandSharedRepairHandles(input: unknown): JsonObject {
  const context = jsonContext(input);
  if (!Object.hasOwn(context, "repairHandleSets")) return context;
  const dictionary = context.repairHandleSets;
  if (!object(dictionary) || dictionary.codec !== SHARED_REPAIR_HANDLES_CODEC ||
    typeof dictionary.contextHash !== "string" || !object(dictionary.sets)) throw new Error("invalid repair dictionary");
  const used = new Set<string>();
  for (const issue of issues(context)) {
    if (!Object.hasOwn(issue, "allowedHandlesRef")) continue;
    const key = issue.allowedHandlesRef;
    const handles = typeof key === "string" ? dictionary.sets[key] : undefined;
    if (typeof key !== "string" || Object.hasOwn(issue, "allowedHandles") || !Array.isArray(handles) ||
      !handles.every((handle) => typeof handle === "string") || contentHash(handles) !== key) throw new Error("repair dictionary reference mismatch");
    issue.allowedHandles = structuredClone(handles);
    delete issue.allowedHandlesRef;
    used.add(key);
  }
  if (used.size !== Object.keys(dictionary.sets).length) throw new Error("unreferenced repair dictionary entry");
  delete context.repairHandleSets;
  if (contentHash(context) !== dictionary.contextHash) throw new Error("repair context binding changed");
  return context;
}
