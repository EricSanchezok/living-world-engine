import { canonicalize, contentHash } from "../models/model-audit";

export const SHARED_STATE_FIRST_LAYOUT = "shared-state-first-v1" as const;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Move only existing object members. Paths, arrays, values and scopes retain
 * their original meanings; no data is factored, dropped, duplicated or added. */
export function serializeModelContext(context: unknown, layout?: typeof SHARED_STATE_FIRST_LAYOUT): string {
  const canonical = canonicalize(context);
  if (!layout) return JSON.stringify(canonical);
  if (layout !== SHARED_STATE_FIRST_LAYOUT || !object(canonical) || !object(canonical.state) ||
    !["shared-json-v2", "shared-json-v3", "shared-json-v3-prefix-v1", "shared-json-v3-catalog-v1"].includes(String(canonical.state.codec)) ||
    !object(canonical.state.shared) || !object(canonical.state.shared.state)) throw new Error("shared state layout requires a complete shared context envelope");
  const prioritize = (value: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries([
    ...keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]),
    ...Object.entries(value).filter(([key]) => !keys.includes(key)),
  ]);
  const shared = prioritize(canonical.state.shared, ["state", "referenceCatalog"]);
  const state = prioritize({ ...canonical.state, shared }, ["shared"]);
  const serialized = JSON.stringify(prioritize({ ...canonical, state }, ["state"]));
  if (contentHash(JSON.parse(serialized)) !== contentHash(canonical)) throw new Error("context layout changed source data");
  return serialized;
}
