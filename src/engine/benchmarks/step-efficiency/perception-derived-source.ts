import { z } from "zod";
import { checkRequestSchema, perceptionDirectiveSchema, type ModelCheckRequestDraft } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const instruction = loadPromptAsset("shared/perception-derived-source.md");
export const PERCEPTION_DERIVED_SOURCE = `perception-derived-source-v1@${contentHash(instruction).slice(0, 16)}`;

export const perceptionDifficultySelectionSchema = z.discriminatedUnion("kind", [
  checkRequestSchema.shape.difficulty.options[0],
  checkRequestSchema.shape.difficulty.options[1].omit({ source: true }),
]);

/** The selected opposed Rating has exactly one canonical numeric source. */
export function derivePerceptionDifficultySource(value: z.infer<typeof perceptionDifficultySelectionSchema>): ModelCheckRequestDraft["difficulty"] {
  const difficulty = perceptionDifficultySelectionSchema.parse(value);
  return difficulty.kind === "opposed"
    ? { ...difficulty, source: { kind: "rating", ref: difficulty.ratingRef } }
    : difficulty;
}

export const perceptionDerivedSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("request_checks"), requests: z.array(checkRequestSchema.extend({ difficulty: perceptionDifficultySelectionSchema })).min(1) }),
  perceptionDirectiveSchema.options[1],
]);

function removeOnce(text: string, fragment: string): string {
  const parts = text.split(fragment);
  if (parts.length !== 2) throw new ModelConfigurationError("perception source instruction is missing or ambiguous");
  return parts.join("");
}

/** Isolate a known dependency without inferring any independent check choice. */
export function perceptionDerivedSourceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.wireJsonSchema || request.preprocessOutput || request.jsonObjectPostlude || request.jsonExamplePolicy !== "omit") {
    throw new ModelConfigurationError("perception source diagnostic requires example omission and no other codec or layout");
  }
  const originalHash = contentHash(request.context);
  const context = z.looseObject({ roleContract: z.looseObject({ engineOwns: z.array(z.string()), existingReferenceRule: z.string() }) }).parse(structuredClone(request.context));
  context.roleContract.existingReferenceRule = removeOnce(context.roleContract.existingReferenceRule, " and cites that same rating as its source");
  context.roleContract.engineOwns.push("opposed difficulty source from the exact selected Rating");
  const contextHash = contentHash(context);
  const system = removeOnce(request.system, " and cites that same Rating as its source") + "\n\n" + instruction;
  const userPrompt = removeOnce(request.userPrompt, " citing that same Rating as its difficulty source");
  return { ...request, context, system, userPrompt,
    promptVersion: `${request.promptVersion}/${PERCEPTION_DERIVED_SOURCE}`,
    wireJsonSchema: z.toJSONSchema(perceptionDerivedSourceSchema, { target: "draft-07" }),
    preprocessOutput: raw => {
      if (contentHash(request.context) !== originalHash || contentHash(context) !== contextHash) {
        throw new ModelConfigurationError("perception source context binding changed");
      }
      const wire = perceptionDerivedSourceSchema.parse(raw);
      const value = wire.kind === "done" ? wire : perceptionDirectiveSchema.parse({ ...wire,
        requests: wire.requests.map(check => ({ ...check, difficulty: derivePerceptionDifficultySource(check.difficulty) })) });
      return { value, symbolRepairs: [] };
    } };
}
