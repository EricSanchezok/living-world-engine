import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";

const CONTRACT = "rejected-cause-domains-v1";
const FIELD = "repairDiagnosticDomains";
type ObjectValue = Record<string, unknown>;
type JsonPath = Array<string | number>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (): never => { throw new ModelConfigurationError("repair diagnostic domain binding changed"); };
const envelopeSchema = z.strictObject({
  contract: z.literal(CONTRACT),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  domains: z.array(z.strictObject({ hash: z.string(), values: z.array(z.unknown()) })).min(1),
  locations: z.array(z.strictObject({
    path: z.array(z.union([z.string(), z.number().int().nonnegative().safe()])).min(1),
    domain: z.number().int().nonnegative().safe(),
  })).min(2),
});

function parentAt(root: unknown, path: JsonPath): ObjectValue | unknown[] {
  let value = root;
  for (const part of path.slice(0, -1)) {
    if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, part)) return fail();
    value = (value as ObjectValue)[part];
  }
  if (!object(value) && !Array.isArray(value)) return fail();
  return value;
}

/** Pool complete repeated domains only inside repair evidence. Registered paths
 * distinguish our references from similarly shaped user/model data. */
export function compactRepairDiagnosticDomains(state: unknown): unknown {
  if (!object(state) || Object.hasOwn(state, FIELD)) return fail();
  const found = new Map<string, { values: unknown[]; paths: JsonPath[] }>();
  const visit = (value: unknown, path: JsonPath): void => {
    if (Array.isArray(value)) { value.forEach((child, index) => visit(child, [...path, index])); return; }
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...path, key];
      if (key === "rejectedDomain" && Array.isArray(child)) {
        const hash = contentHash(child), entry = found.get(hash);
        if (entry) entry.paths.push(next);
        else found.set(hash, { values: child, paths: [next] });
      } else visit(child, next);
    }
  };
  if (object(state.shared)) visit(state.shared.repair, ["shared", "repair"]);
  if (Array.isArray(state.slots)) state.slots.forEach((slot, index) => {
    if (object(slot) && object(slot.delta)) visit(slot.delta.repair, ["slots", index, "delta", "repair"]);
  });
  const repeated = [...found.entries()].filter(([, entry]) => entry.paths.length > 1 && JSON.stringify(entry.values).length >= 512);
  if (!repeated.length) return state;
  const encoded = structuredClone(state);
  const domains: Array<{ hash: string; values: unknown[] }> = [];
  const locations: Array<{ path: JsonPath; domain: number }> = [];
  for (const [hash, entry] of repeated) {
    const domain = domains.length;
    domains.push({ hash, values: structuredClone(entry.values) });
    for (const path of entry.paths) {
      const parent = parentAt(encoded, path);
      (parent as ObjectValue)[path.at(-1)!] = { sharedRejectedDomain: domain };
      locations.push({ path, domain });
    }
  }
  encoded[FIELD] = { contract: CONTRACT, sourceHash: contentHash(state), domains, locations };
  // Small inventories or many short occurrences can cost more in path metadata.
  return JSON.stringify(encoded).length < JSON.stringify(state).length ? encoded : state;
}

/** Restore only declared occurrences and reject source, domain or reference drift. */
export function expandRepairDiagnosticDomains(state: unknown): unknown {
  if (!object(state)) return fail();
  if (!Object.hasOwn(state, FIELD)) return state;
  const parsed = envelopeSchema.safeParse(state[FIELD]);
  if (!parsed.success) return fail();
  const { domains, locations, sourceHash } = parsed.data;
  const hashes = new Set<string>();
  for (const domain of domains) {
    if (contentHash(domain.values) !== domain.hash || hashes.has(domain.hash)) return fail();
    hashes.add(domain.hash);
  }
  const restored = structuredClone(state);
  delete restored[FIELD];
  const visited = new Set<string>(), used = new Set<number>();
  for (const { path, domain } of locations) {
    const inRepair = (path[0] === "shared" && path[1] === "repair") ||
      (path[0] === "slots" && typeof path[1] === "number" && path[2] === "delta" && path[3] === "repair");
    if (!inRepair || path.at(-1) !== "rejectedDomain" || !domains[domain]) return fail();
    const key = JSON.stringify(path);
    if (visited.has(key)) return fail();
    visited.add(key); used.add(domain);
    const parent = parentAt(restored, path), field = path.at(-1)!;
    if (!Object.hasOwn(parent, field)) return fail();
    const reference = (parent as ObjectValue)[field];
    if (!object(reference) || Object.keys(reference).length !== 1 || reference.sharedRejectedDomain !== domain) return fail();
    (parent as ObjectValue)[field] = structuredClone(domains[domain]!.values);
  }
  if (used.size !== domains.length || contentHash(restored) !== sourceHash) return fail();
  return restored;
}
