import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";

const ambiguous = "Describe semantic effects with relevant causes and preconditions while leaving deterministic writes and time advancement to the engine";
const explicit = "Propose every justified persistent change explicitly in operations or mechanicInvocations, with relevant causes and preconditions; the engine validates and applies these proposed writes and advances time, but does not invent writes from an outcome summary";
const order = ["operations", "mechanicInvocations", "events", "outcomes", "decisionRequests"] as const;
const notice = "Emit the complete JSON object in this order: operations, mechanicInvocations, events, outcomes, decisionRequests. Write the actual proposed changes before describing their results. Assertions and summaries only check or describe state; they never apply a change. Choose outcome status using the committed receipt and temporal boundary, and assert only facts true after those explicit changes and the engine time advance. Preserve all required fields and arbitrary action semantics. Do not add analysis or a separate planning call.";

/** Same input state and output value language, ordered effects before claims. */
export function transitionEffectsFirst<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.userPrompt.split(ambiguous).length !== 2) throw new Error("transition write instruction drift");
  const schema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || Object.keys(properties).length !== order.length || order.some((key) => !Object.hasOwn(properties, key))) throw new Error("complete transition schema required");
  const wireJsonSchema = { ...schema, properties: Object.fromEntries(order.map((key) => [key, properties[key]])) };
  if (contentHash(wireJsonSchema) !== contentHash(schema)) throw new Error("output schema semantics changed");
  const userPrompt = request.userPrompt.replace(ambiguous, explicit) + "\n\n" + notice;
  return { ...request, userPrompt, wireJsonSchema,
    promptVersion: `${request.promptVersion}/effects-first-v1@${contentHash({ userPrompt, wireSchemaText: JSON.stringify(wireJsonSchema) }).slice(0, 16)}` };
}
