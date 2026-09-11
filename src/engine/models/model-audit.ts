import { createHash } from "node:crypto";
import type { ModelContextAudit } from "../contracts/model";

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function contentHash(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(canonicalize(value));
  return createHash("sha256").update(serialized).digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function itemCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return null;
}

export function measureModelContext(context: unknown, contextJson?: string): ModelContextAudit {
  return measureCanonicalContext(canonicalize(context), contextJson);
}

/** Own one request's normalized snapshot. Consumers must not mutate its value;
 * hashes and measurements deliberately reuse the same detached input. */
export function prepareModelContext(context: unknown): {
  value: unknown;
  hash: string;
  measure: (contextJson?: string) => ModelContextAudit;
} {
  const value = canonicalize(context);
  // contentHash treats strings as already serialized bytes. Preserve that
  // contract for scalar string contexts as well as normalized JSON objects.
  const hash = contentHash(typeof value === "string" ? value : JSON.stringify(value));
  return { value, hash, measure: (contextJson) => measureCanonicalContext(value, contextJson) };
}

function measureCanonicalContext(canonical: unknown, contextJson?: string): ModelContextAudit {
  const counts: ModelContextAudit["counts"] = {
    history: 0,
    events: 0,
    agents: 0,
    entities: 0,
    facts: 0,
    beliefs: 0,
    evidence: 0,
    observations: 0,
  };
  const countKeys: Record<string, keyof ModelContextAudit["counts"]> = {
    history: "history",
    semanticHistory: "history",
    subjectiveHistory: "history",
    events: "events",
    agents: "agents",
    agentEpistemics: "agents",
    entities: "entities",
    localEntities: "entities",
    facts: "facts",
    claims: "beliefs",
    evidence: "evidence",
    observations: "observations",
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "agent" && entry && typeof entry === "object" && !Array.isArray(entry)) {
        counts.agents += 1;
        visit(entry);
        continue;
      }
      const countKey = countKeys[key];
      const count = itemCount(entry);
      if (countKey && count !== null) {
        counts[countKey] += count;
        if (Array.isArray(entry)) entry.forEach(visit);
        else Object.values(entry as Record<string, unknown>).forEach(visit);
        continue;
      }
      visit(entry);
    }
  };
  visit(canonical);
  const sections = canonical && typeof canonical === "object" && !Array.isArray(canonical)
    ? Object.fromEntries(Object.entries(canonical as Record<string, unknown>).map(([key, value]) => [
      key,
      { utf8Bytes: utf8Bytes(value), itemCount: itemCount(value) },
    ]))
    : { value: { utf8Bytes: utf8Bytes(canonical), itemCount: itemCount(canonical) } };
  return {
    utf8Bytes: Buffer.byteLength(contextJson ?? JSON.stringify(canonical, null, 2), "utf8"),
    sections,
    counts,
  };
}
