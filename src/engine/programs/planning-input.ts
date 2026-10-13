import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ProgramResources } from "./definition";

function omit(value: JsonValue, keys: readonly string[]): JsonValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))) : value;
}
function unique(values: JsonValue): JsonValue {
  if (!Array.isArray(values)) return values;
  return [...new Map(values.map(value => [contentHash(value), value])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
function evidenceContent(value: JsonValue): JsonValue {
  const content = omit(value, ["id", "step"]);
  // Delivery provenance points to a new immutable observation on every delivery.
  // The testimony description still identifies its perceived speaker and words.
  if (content !== null && typeof content === "object" && !Array.isArray(content) &&
    "sourceId" in content && typeof content.sourceId === "string" && /^rt:observation:[a-f0-9]{64}$/u.test(content.sourceId)) {
    return { ...content, sourceId: "delivered-observation" };
  }
  return content;
}

/** Retry eligibility only. Model context, dependency versions and durable evidence remain complete. */
export function privatePlanningInput(resources: ProgramResources): string {
  const values = Object.fromEntries(Object.entries(resources)
    .filter(([key]) => key !== "clock" && !key.startsWith("evidence:") && !key.startsWith("claim:"))
    .map(([key, resource]) => {
      const metadata = key === "evidence" ? ["id", "step"] : key === "claims" ? ["id", "evidenceIds"]
        : key === "observations" ? ["revision", "step"] : [];
      return [key, metadata.length && Array.isArray(resource.value)
        ? unique(resource.value.map(value => key === "evidence" ? evidenceContent(value) : omit(value, metadata))) : resource.value];
    }));
  return contentHash(values);
}
