import { z } from "zod";
import { programKey } from "../programs/definition";
import type { JsonValue } from "../runtime/json";
import { closeWorldProgramReferences, worldProgramSchema, type WorldProgramDefinition } from "./world-program";

/** The model declares a parameter and its binding together; entity IDs have an exact domain. */
export function worldDraftSchema(entityIds: string[]) {
  const description = z.string().trim().min(1);
  const parameter = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("entity"), description, value: z.enum(entityIds as [string, ...string[]]) }).strict(),
    z.object({ kind: z.literal("text"), description, value: z.string() }).strict(),
    z.object({ kind: z.literal("number"), description, value: z.number().finite() }).strict(),
  ]);
  return z.object({ definition: worldProgramSchema.extend({ parameters: z.record(programKey, parameter) }) }).strict();
}

export function decodeWorldDraft(raw: unknown, entityIds: string[]) {
  const draft = worldDraftSchema(entityIds).parse(raw), parameters: Record<string, JsonValue> = {};
  const declaration: WorldProgramDefinition = { ...draft.definition, parameters: Object.fromEntries(
    Object.entries(draft.definition.parameters).map(([key, { value, ...parameter }]) => {
      parameters[key] = value;
      return [key, parameter];
    })) };
  return { definition: closeWorldProgramReferences(declaration), parameters };
}

export function encodeWorldDraft(definition: WorldProgramDefinition, parameters: Record<string, JsonValue>) {
  return { definition: { ...definition, parameters: Object.fromEntries(Object.entries(definition.parameters)
    .map(([key, declaration]) => [key, { ...declaration, value: parameters[key] }])) } };
}
