import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

export const PERCEPTION_NO_EXAMPLE = "perception-no-example-v1";

/** Isolate an existing transport option without changing the semantic contract. */
export function perceptionNoExampleRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.jsonExamplePolicy || request.jsonObjectPostlude || request.promptVersion.includes(PERCEPTION_NO_EXAMPLE)) {
    throw new ModelConfigurationError("perception example diagnostic requires an unmodified example policy");
  }
  return { ...request, jsonExamplePolicy: "omit", promptVersion: `${request.promptVersion}/${PERCEPTION_NO_EXAMPLE}` };
}

const bodyShape = z.looseObject({ messages: z.array(z.looseObject({ role: z.string(), content: z.string() })) });
const marker = "\nExample JSON output shape: ";
const notice = "\nThe example is illustrative and non-normative; follow the task's explicit cardinality, coverage, and non-empty requirements over this example.";

/** Compare complete physical requests; an unchanged logical context is insufficient. */
export function verifyOnlyPerceptionExampleOmitted(baseline: unknown, treatment: unknown): void {
  const original = bodyShape.parse(baseline), changed = bodyShape.parse(treatment);
  const expected = structuredClone(original);
  const messages = expected.messages.filter(message => message.role === "user");
  if (messages.length !== 1) throw new ModelConfigurationError("perception example diagnostic requires one user message");
  const message = messages[0]!, parts = message.content.split(marker);
  if (parts.length !== 2) throw new ModelConfigurationError("perception example boundary is missing or ambiguous");
  const tail = parts[1]!, end = tail.indexOf(notice);
  if (end < 0 || tail.indexOf(notice, end + notice.length) >= 0) throw new ModelConfigurationError("perception example notice is missing or ambiguous");
  const example = JSON.parse(tail.slice(0, end)) as { kind?: unknown };
  if (example.kind !== "request_checks") throw new ModelConfigurationError("perception example source branch changed");
  message.content = parts[0]! + tail.slice(end + notice.length);
  if (contentHash(expected) !== contentHash(changed)) throw new ModelConfigurationError("perception treatment changed more than the example");
}
