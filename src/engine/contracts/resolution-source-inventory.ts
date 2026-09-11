import { contentHash } from "../models/model-audit";
import type { ModelReferenceCatalog } from "./model-context";

export const RESOLUTION_SOURCE_INVENTORY = "action-means-sources-v1";

/** Enumerate the existing prompt's means-source choices without selecting evidence for the model. */
export function resolutionMeansSources(
  catalog: Pick<ModelReferenceCatalog, "candidates">,
  actionRef: string,
  grounding: { requiredExistingRefs: readonly string[]; potentiallyAffectedExistingRefs: readonly string[]; globalFallback: boolean },
): Array<{ kind: string; ref: string }> {
  const dependencies = new Set([...grounding.requiredExistingRefs, ...grounding.potentiallyAffectedExistingRefs]);
  return catalog.candidates.filter(candidate => {
    if (!candidate.allowedUses.includes("source")) return false;
    if (candidate.kind === "action") return candidate.handle === actionRef;
    if (candidate.kind === "law") return true;
    return ["entity", "fact", "condition", "rating", "placement"].includes(candidate.kind) &&
      (grounding.globalFallback || dependencies.has(candidate.handle));
  }).map(candidate => ({ kind: candidate.kind, ref: candidate.handle }));
}


export const RESOLUTION_FACT_EVIDENCE_NOTICE = "Each factEvidence record is an exact copy from this request's visible canonical fact snapshot. The allowedMeansSources list is a menu, not a checklist of means to emit. Select only sources that support the actual described means and original action. Read the selected fact's predicate, typed value and description: sharing an entity or location does not support a different claim. Preserve actor, delegation, quantities and conditions. The engine neither chooses evidence nor fills in action meaning.";
export const RESOLUTION_FACT_EVIDENCE = `action-local-fact-evidence-v1@${contentHash(RESOLUTION_FACT_EVIDENCE_NOTICE).slice(0, 16)}`;

/** Copy only records already visible in this exact request, without selecting sources. */
export function withResolutionFactEvidence(sources: readonly { kind: string; ref: string }[], facts: Record<string, unknown>): Array<{
  kind: string; ref: string; factEvidence?: { sourcePath: string[]; recordHash: string; record: object };
}> {
  return sources.map(source => {
    if (source.kind !== "fact") return { ...source };
    const record = facts[source.ref];
    if (!Object.hasOwn(facts, source.ref) || !record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`resolution fact evidence missing visible record for ${source.ref}`);
    }
    return { ...source, factEvidence: {
      sourcePath: ["state", "canonicalTruth", "facts", source.ref],
      recordHash: contentHash(record), record: structuredClone(record),
    } };
  });
}
