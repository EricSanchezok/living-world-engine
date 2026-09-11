import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { CANONICAL_TRANSITION_EVIDENCE } from "./transition-evidence-worklist";

export const CANONICAL_SPARSE_ARRAYS = "canonical-sparse-arrays-v1";
const fields = ["mechanicInvocations", "operations", "events", "decisionRequests"] as const;
const instruction = loadPromptAsset("shared/canonical-sparse-arrays.md");
const explicitEmptyInstruction = "Every required output field must be present, including explicitly empty effect arrays when there are no supported effects.";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Omit empty containers only; all semantic values and their ordering survive. */
export function encodeSparseTransitionArrays(value: ObjectValue): ObjectValue {
  const copy = structuredClone(value);
  for (const field of fields) if (Array.isArray(copy[field]) && copy[field].length === 0) delete copy[field];
  return copy;
}

/** Only requests declaring the sparse contract may interpret omission as []. */
export function decodeSparseTransitionArrays(value: unknown): ObjectValue {
  if (!object(value)) throw new z.ZodError([{ code: "custom", path: [], message: "sparse transition requires a root object" }]);
  const copy = structuredClone(value);
  for (const field of fields) {
    if (!Object.hasOwn(copy, field)) copy[field] = [];
    else if (!Array.isArray(copy[field])) throw new z.ZodError([{ code: "custom", path: [field], message: "sparse effect category must be an array or omitted" }]);
  }
  return copy;
}

/** Research-only canonical wire contract; the production schema is unchanged. */
export function canonicalSparseArraysRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-transition" || request.schemaName !== "truth_transition") return request;
  if (request.promptVersion.includes(CANONICAL_SPARSE_ARRAYS) || !request.promptVersion.includes(CANONICAL_TRANSITION_EVIDENCE) ||
    request.userPrompt.split(explicitEmptyInstruction).length !== 2 || !request.wireJsonSchema) {
    throw new ModelConfigurationError("sparse transition requires the unchanged canonical evidence contract exactly once");
  }
  const schema = structuredClone(request.wireJsonSchema) as ObjectValue;
  const properties = schema.properties, required = schema.required;
  if (!object(properties) || !Array.isArray(required) ||
    Object.keys(properties).length !== fields.length + 1 || !required.includes("outcomes") ||
    fields.some(field => !required.includes(field) || !object(properties[field]) || properties[field].type !== "array" || Number(properties[field].minItems ?? 0) > 0)) {
    throw new ModelConfigurationError("sparse transition root schema changed");
  }
  schema.required = required.filter(field => !fields.includes(field as typeof fields[number]));
  const userPrompt = request.userPrompt.replace(explicitEmptyInstruction, instruction);
  return { ...request, userPrompt, wireJsonSchema: schema,
    promptVersion: `${request.promptVersion}/${CANONICAL_SPARSE_ARRAYS}@${contentHash({ schema, instruction }).slice(0, 16)}`,
    preprocessOutput: value => {
      const expanded = decodeSparseTransitionArrays(value);
      return request.preprocessOutput ? request.preprocessOutput(expanded) : { value: expanded, symbolRepairs: [] };
    },
  };
}
