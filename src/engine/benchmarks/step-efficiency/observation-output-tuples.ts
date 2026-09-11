import { z } from "zod";
import { modelObservationRenderDraftSchema, observationProjectionBatchSchema } from "../../contracts/llm-schemas";

const fields = modelObservationRenderDraftSchema.shape;
const claim = fields.apparentClaims.element.shape;
const claimTuple = z.tuple([claim.subjectRef, claim.predicate, claim.value, claim.description]);
export const observationTupleBatchSchema = z.strictObject({
  slots: z.array(z.strictObject({
    slot: observationProjectionBatchSchema.shape.slots.element.shape.slot,
    result: z.tuple([fields.summary, fields.introductions, z.array(claimTuple), fields.sourceEventRefs]),
  })),
});

/** Replace field names only. Every field, including empty arrays, is mandatory. */
export function encodeObservationTuples(value: unknown) {
  const parsed = observationProjectionBatchSchema.parse(value);
  return observationTupleBatchSchema.parse({ slots: parsed.slots.map(({ slot, result }) => ({ slot,
    result: [result.summary, result.introductions, result.apparentClaims.map((entry) =>
      [entry.subjectRef, entry.predicate, entry.value, entry.description]), result.sourceEventRefs],
  })) });
}

export function decodeObservationTuples(value: unknown) {
  const parsed = observationTupleBatchSchema.parse(value);
  return observationProjectionBatchSchema.parse({ slots: parsed.slots.map(({ slot, result }) => ({ slot,
    result: { summary: result[0], introductions: result[1], apparentClaims: result[2].map((entry) =>
      ({ subjectRef: entry[0], predicate: entry[1], value: entry[2], description: entry[3] })), sourceEventRefs: result[3] },
  })) });
}

export const OBSERVATION_TUPLE_NOTICE = "Output representation: each slot keeps {slot,result}. result is exactly [summary,introductions,apparentClaims,sourceEventRefs]. Each apparentClaims entry is exactly [subjectRef,predicate,value,description]. These positional arrays replace only object field names; all four positions are required even when empty. Keep introduction and value objects unchanged, including their kind and typed fields. All existing observation semantics, evidence, identity and coverage requirements apply. The decoder only restores these field names; it never supplies a missing value or evidence. Follow the supplied tuple JSON Schema.";
