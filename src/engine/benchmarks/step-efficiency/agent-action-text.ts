import { z } from "zod";
import { existingReferenceHandleSchema } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/agent-action-text.md");
const description = loadPromptAsset("shared/agent-action-text-raw.md");
const textActionSchema = z.strictObject({
  rawText: z.string().min(1),
  targetHandles: z.array(existingReferenceHandleSchema),
});
const envelopeSchema = z.object({
  slots: z.array(z.object({ nextActionIntent: textActionSchema }).passthrough()),
}).passthrough();
export const AGENT_ACTION_TEXT = `agent-action-text-v1@${contentHash({ instruction, description,
  schema: z.toJSONSchema(textActionSchema, { target: "draft-07" }), embedding: "goal=rawText;means=null" }).slice(0, 16)}`;
type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("agent action text schema drift");
  return value as Value;
};

/** New producer embedding, not an encoder or migration for old action triplets. */
export function decodeAgentActionText(value: unknown) {
  const envelope = envelopeSchema.parse(value);
  return { ...envelope, slots: envelope.slots.map(slot => ({ ...slot, nextActionIntent: {
    ...slot.nextActionIntent, goal: slot.nextActionIntent.rawText, means: null,
  } })) };
}

export function agentActionTextRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  if (request.promptVersion.includes(AGENT_ACTION_TEXT)) throw new ModelConfigurationError("agent action text already applied");
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const slots = record(record(record(wireJsonSchema.properties).slots).items);
  const action = record(record(slots.properties).nextActionIntent), fields = record(action.properties);
  if (Object.keys(fields).sort().join(",") !== "goal,means,rawText,targetHandles" ||
    !Array.isArray(action.required) || [...action.required].sort().join(",") !== "goal,means,rawText,targetHandles") {
    throw new ModelConfigurationError("agent action text fields differ");
  }
  delete fields.goal; delete fields.means;
  action.required = ["rawText", "targetHandles"];
  record(fields.rawText).description = description;
  const sourceHash = contentHash(request.context);
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${AGENT_ACTION_TEXT}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash) throw new ModelConfigurationError("agent action text source changed");
      const value = decodeAgentActionText(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
