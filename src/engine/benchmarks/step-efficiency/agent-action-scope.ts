import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/agent-action-scope.md");
const descriptions = {
  rawText: loadPromptAsset("shared/agent-action-scope-raw-text.md"),
  goal: loadPromptAsset("shared/agent-action-scope-goal.md"),
  means: loadPromptAsset("shared/agent-action-scope-means.md"),
};
export const AGENT_ACTION_SCOPE = `agent-action-scope-v1@${contentHash({ instruction, descriptions }).slice(0, 16)}`;
type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("agent action scope schema drift");
  return value as Value;
};

/** Experimental source-coherence instructions; all fields, legal values,
 * private contexts and canonical output validation remain unchanged. */
export function agentActionScopeRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  if (request.promptVersion.includes(AGENT_ACTION_SCOPE)) throw new ModelConfigurationError("agent action scope already applied");
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const slots = record(record(record(wireJsonSchema.properties).slots).items);
  const fields = record(record(record(slots.properties).nextActionIntent).properties);
  for (const [key, description] of Object.entries(descriptions)) record(fields[key]).description = description;
  const sourceHash = contentHash(request.context);
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${AGENT_ACTION_SCOPE}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash) throw new ModelConfigurationError("agent action scope source changed");
      return request.preprocessOutput?.(raw) ?? { value: raw, symbolRepairs: [] };
    } };
}
