import { z } from "zod";
import { contentHash } from "../models/model-audit";

const record = z.record(z.string(), z.unknown());
const sourceSchema = z.object({
  task: record,
  state: z.object({
    actionSet: z.object({ available: z.array(z.object({ actionRef: z.string(), actorRef: z.string() }).passthrough()) }).passthrough(),
    candidate: z.object({
      observations: z.array(z.object({ observationRef: z.string(), observerRef: z.string(),
        apparentClaims: z.array(z.object({ subjectRef: z.unknown() }).passthrough()), sourceEventRefs: z.array(z.string()) }).passthrough()).min(1),
      outcomes: z.array(z.object({ actionRef: z.string() }).passthrough()),
      events: z.array(record), operations: z.array(record),
    }).passthrough(),
  }).passthrough(),
  referenceCatalog: z.object({ candidates: z.array(z.object({ handle: z.string(), label: z.string(), kind: z.string() }).passthrough()) }).passthrough(),
}).passthrough();

export const CAUSAL_OBSERVATION_COVERAGE_INSTRUCTION = `Inspect every observation in task.observationReviewWorklist and return exactly one check for each observationRef. The worklist copies existing evidence into adjacent rows; it does not add facts, permissions, or prove any claim. Read the full original context for cross-action support and uncertainty.
For each observation, check the subject of EVERY apparent claim, not only the narrator in its summary. An action target is not its initiator. A proposed action or continuing activity is not evidence that a sub-action was already performed, a message delivered, or another person agreed. Compare realized statements with the exact outcomes, events, state, reactions and assertions; an identity or office assertion proves only that identity or office. Ongoing attempts can legitimately have no physical delta. Do not reject an honestly pending action merely for having no write.
Use supported only when the complete observation preserves actor attribution, realization and knowledge boundaries. Use unsupported for a concrete contradiction; use insufficient when the necessary evidence is unavailable. For supported use issue none; otherwise select the issue. supportRefs must be existing referenceCatalog handles for the evidence used; they cannot be invented or be worklist paths. This is an evidence classification, not a replacement observation or a request for chain of thought. Return only the complete JSON schema object.`;

/** Diagnostic-only evidence layout. No context is removed and no model conclusion is used as a source fact. */
export function prepareCausalObservationCoverage(context: unknown) {
  const source = sourceSchema.parse(context);
  if (Object.hasOwn(source.task, "observationReviewWorklist")) throw new Error("coverage worklist already attached");
  const observations = source.state.candidate.observations;
  const refs = observations.map(observation => observation.observationRef);
  if (new Set(refs).size !== refs.length) throw new Error("duplicate observation reference");
  const catalog = new Map(source.referenceCatalog.candidates.map(candidate => [candidate.handle, candidate]));
  if (refs.some(ref => catalog.get(ref)?.kind !== "observation")) throw new Error("observation catalog binding missing");
  const rows = observations.map(observation => {
    const actions = source.state.actionSet.available.filter(action => action.actorRef === observation.observerRef);
    const ownRefs = new Set(actions.map(action => action.actionRef));
    return {
      observation,
      ownActions: actions,
      ownOutcomes: source.state.candidate.outcomes.filter(outcome => ownRefs.has(outcome.actionRef)),
      claimSubjects: observation.apparentClaims.map((claim, claimIndex) => ({ claimIndex, subjectRef: claim.subjectRef,
        catalogEntry: typeof claim.subjectRef === "string" ? catalog.get(claim.subjectRef) ?? null : null })),
      explicitSourceEvents: source.state.candidate.events.filter(event => observation.sourceEventRefs.includes(String(event.eventRef))),
    };
  });
  const schema = z.strictObject({ checks: z.array(z.strictObject({
    observationRef: z.enum(refs as [string, ...string[]]),
    verdict: z.enum(["supported", "unsupported", "insufficient"]),
    issue: z.enum(["none", "actor-attribution", "unsupported-realization", "knowledge-access", "other"]),
    supportRefs: z.array(z.string()),
  })).length(refs.length) });
  return {
    context: { ...structuredClone(source), task: { ...structuredClone(source.task), observationReviewWorklist: {
      contract: "causal-observation-coverage-v1", sourceContextHash: contentHash(context), rows: structuredClone(rows),
    } } },
    schema,
    validate(value: unknown) {
      const parsed = schema.parse(value);
      if (new Set(parsed.checks.map(check => check.observationRef)).size !== refs.length) throw new Error("duplicate coverage check");
      for (const check of parsed.checks) {
        if ((check.verdict === "supported") !== (check.issue === "none")) throw new Error("coverage verdict/issue mismatch");
        if (check.supportRefs.some(ref => !catalog.has(ref))) throw new Error("coverage evidence reference missing");
      }
      return parsed;
    },
  };
}
