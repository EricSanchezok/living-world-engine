import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

export const PERCEPTION_SOURCE_FIDELITY_POSTLUDE = "\n\nSource fidelity for this perception response:\n"
  + "Ground every concrete statement in every output field, including reason, stakes, stimulus summary and claim descriptions, in the supplied source action, current world evidence, authored rules and fixed check results. Preserve who acts and who observes, the action actually attempted, current locations, time, modality and channel direction. Do not add a plausible movement, utterance, object identity, location or causal link that the source does not establish. An unnamed obstacle cannot inherit the identity of a nearby named object without evidence. Explicit authored constraints and current placements govern over generic expectations. A cited rule that denies access cannot support a check granting access, and an attempted action alone does not establish its observer's channel. Distinguish established access, established absence of access and supported uncertainty; preserve every justified stimulus and every required check. Report all assigned targets and retain all supported perceptible information. Do not remove a required field, claim or uncertainty to avoid this requirement. Return the original schema without an added review, explanation or reasoning transcript.";

export const PERCEPTION_SOURCE_FIDELITY = `perception-source-fidelity-v1@${contentHash(PERCEPTION_SOURCE_FIDELITY_POSTLUDE).slice(0, 16)}`;

/** A bounded prompt experiment; source data, decoding and acceptance stay canonical. */
export function perceptionSourceFidelityRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.jsonExamplePolicy !== undefined || request.jsonObjectPostlude !== undefined || request.promptVersion.includes(PERCEPTION_SOURCE_FIDELITY)) {
    throw new ModelConfigurationError("perception source fidelity requires an unmodified request layout");
  }
  return { ...request, jsonObjectPostlude: PERCEPTION_SOURCE_FIDELITY_POSTLUDE,
    promptVersion: `${request.promptVersion}/${PERCEPTION_SOURCE_FIDELITY}` };
}

const bodyShape = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.string() })) });

/** Verify the complete physical body, including model settings and the default example. */
export function verifyOnlyPerceptionSourceFidelityAdded(baseline: unknown, treatment: unknown): void {
  const original = bodyShape.parse(baseline), changed = bodyShape.parse(treatment);
  const expected = structuredClone(original);
  const messages = expected.messages.filter(message => message.role === "user");
  if (messages.length !== 1 || messages[0]!.content.includes(PERCEPTION_SOURCE_FIDELITY_POSTLUDE)) {
    throw new ModelConfigurationError("perception source fidelity requires one unmodified user message");
  }
  messages[0]!.content += PERCEPTION_SOURCE_FIDELITY_POSTLUDE;
  if (contentHash(expected) !== contentHash(changed)) {
    throw new ModelConfigurationError("perception treatment changed more than source fidelity instructions");
  }
}
