import { z } from "zod";
import { observationProjectionBatchSchema } from "../../contracts/llm-schemas";
import { parseLosslessExperimentJson } from "../action-compilation/lossless-json";

export interface ObservationSlotBinding {
  slot: number;
  observerRef: string;
  localRefs: string[];
  entityRefs: string[];
  eventRefs: string[];
}

/** Deterministic format, coverage and typed-reference checks only. This does
 * not judge prose, attribution or the truth of apparent claims. */
export function scoreObservationPrefix(text: string, expected: readonly ObservationSlotBinding[]) {
  let rawJson = true;
  try { JSON.parse(text); } catch { rawJson = false; }
  try {
    const parsed = observationProjectionBatchSchema.parse(parseLosslessExperimentJson(text).value);
    if (parsed.slots.length !== expected.length || new Set(parsed.slots.map((slot) => slot.slot)).size !== expected.length) throw new Error("observation slot coverage mismatch");
    for (const { slot, result } of parsed.slots) {
      const binding = expected.find((row) => row.slot === slot);
      if (!binding) throw new Error("observation slot outside source");
      const proposals = new Set<string>(result.introductions.map((entry) => entry.localEntity.proposalKey));
      if (proposals.size !== result.introductions.length) throw new Error("duplicate local proposal identity");
      const local = (ref: string | { proposalKey: string }) => typeof ref === "string" ? binding.localRefs.includes(ref) : proposals.has(ref.proposalKey);
      for (const introduction of result.introductions) {
        if (introduction.canonicalEntityRef !== null && (typeof introduction.canonicalEntityRef !== "string" || !binding.entityRefs.includes(introduction.canonicalEntityRef))) throw new Error("unavailable canonical introduction");
      }
      for (const claim of result.apparentClaims) {
        if (!local(claim.subjectRef) || (claim.value.kind === "local_entity" && !local(claim.value.entityRef))) throw new Error("observer-local reference outside slot");
      }
      if (result.sourceEventRefs.some((ref) => typeof ref !== "string" || !binding.eventRefs.includes(ref))) throw new Error("unavailable source event");
    }
    return { rawJson, schemaCoverageReferences: true, slots: parsed.slots.length, fullSemantics: "unassessed" as const, error: null };
  } catch (error) {
    return { rawJson, schemaCoverageReferences: false, slots: 0, fullSemantics: "unassessed" as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export const observationSourceContextSchema = z.object({
  task: z.object({ slots: z.array(z.object({ slot: z.number().int(), observerBinding: z.object({ observerRef: z.string(), existingLocalEntityRefs: z.array(z.string()) }) })) }),
});
