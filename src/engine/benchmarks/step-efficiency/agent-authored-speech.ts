import { z } from "zod";
import { existingReferenceHandleSchema, referenceHandleFor } from "../../contracts/model-context";
import type { AgentActionProposal } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

export const authoredActionSchema = z.strictObject({ kind: z.enum(["open", "speak"]), text: z.string().min(1).regex(/\S/u),
  targetHandles: z.array(existingReferenceHandleSchema) });
const envelopeSchema = z.object({ slots: z.array(z.object({ nextActionIntent: authoredActionSchema }).passthrough()) }).passthrough();
const instruction = loadPromptAsset("shared/agent-authored-speech.md");
export const AUTHORED_SPEECH_PREFIX = "AUTHORED_SPEECH_V1: ";
export const AGENT_AUTHORED_SPEECH = `agent-authored-speech-v1@${contentHash({ instruction,
  schema: z.toJSONSchema(authoredActionSchema, { target: "draft-07" }), embedding: AUTHORED_SPEECH_PREFIX }).slice(0, 16)}`;

/** Benchmark-only proposal encoding; rationale and provenance are in decision 0209. */
export function decodeAgentAuthoredSpeech(value: unknown) {
  const envelope = envelopeSchema.parse(value);
  return { ...envelope, slots: envelope.slots.map(slot => {
    const action = slot.nextActionIntent;
    const rawText = action.kind === "open" ? action.text : AUTHORED_SPEECH_PREFIX + JSON.stringify({ utterance: action.text });
    return { ...slot, nextActionIntent: { rawText, goal: rawText, means: null, targetHandles: action.targetHandles } };
  }) };
}

/** Bind a proposal to its materialized actor, without inferring a kind from raw player text. */
export function inspectAuthoredSpeechProposal(action: AgentActionProposal, sourceChoice: unknown) {
  const choice = authoredActionSchema.parse(sourceChoice);
  const rawText = choice.kind === "open" ? choice.text : AUTHORED_SPEECH_PREFIX + JSON.stringify({ utterance: choice.text });
  if (action.rawText !== rawText || action.goal !== rawText || action.means !== null || action.targetIds.length !== choice.targetHandles.length ||
    !choice.targetHandles.every((handle, index) => handle === referenceHandleFor("local_entity", action.targetIds[index]!))) {
    throw new ModelConfigurationError("Authored speech inspection differs from the materialized proposal");
  }
  return choice.kind === "open" ? null : {
    sourceActionId: action.id, speakerAgentId: action.actorId, baseRevision: action.baseRevision,
    utterance: choice.text, intendedAddresseeLocalIds: [...action.targetIds],
    delivery: "unadjudicated" as const,
  };
}

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("Authored speech schema drift");
  return value as Value;
};

export function agentAuthoredSpeechRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (!["agent-bootstrap", "agent-mind"].includes(request.role) || request.schemaName !== "agent_mind_batch_output") return request;
  if (request.promptVersion.includes("agent-authored-speech-v1")) throw new ModelConfigurationError("Authored speech already applied");
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  const slots = record(record(record(wireJsonSchema.properties).slots).items), fields = record(slots.properties);
  const action = record(fields.nextActionIntent), oldFields = record(action.properties);
  if (Object.keys(oldFields).sort().join(",") !== "goal,means,rawText,targetHandles" ||
    !Array.isArray(action.required) || [...action.required].sort().join(",") !== "goal,means,rawText,targetHandles") {
    throw new ModelConfigurationError("Authored speech requires the original action contract");
  }
  const replacement = z.toJSONSchema(authoredActionSchema, { target: "draft-07" }) as Value;
  delete replacement.$schema;
  record(replacement.properties).targetHandles = structuredClone(oldFields.targetHandles);
  fields.nextActionIntent = replacement;
  const sourceHash = contentHash(request.context), schemaHash = contentHash(wireJsonSchema);
  return { ...request, wireJsonSchema, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${AGENT_AUTHORED_SPEECH}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash || contentHash(wireJsonSchema) !== schemaHash) throw new ModelConfigurationError("Authored speech source or schema changed");
      const value = decodeAgentAuthoredSpeech(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
