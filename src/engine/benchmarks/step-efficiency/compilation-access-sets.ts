import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const names = { requiredExistingCandidateKeys: "readCandidateKeys", potentiallyAffectedCandidateKeys: "writeCandidateKeys" } as const;
const instruction = loadPromptAsset("shared/compilation-access-sets.md");
export const COMPILATION_ACCESS_SETS = `explicit-compilation-access-sets-v1@${contentHash({ names, instruction }).slice(0, 16)}`;
const translate = (text: string): string => Object.entries(names).reduce((value, [original, wire]) => value.replaceAll(original, wire), text);

function sourceSignature(request: StructuredModelRequest<unknown>): string {
  return contentHash({ context: request.context, system: request.system, userPrompt: request.userPrompt,
    schema: request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }) });
}

/** Rename only the two access-set fields. The original decoder, schema and
 * materializer continue to own their contents and all temporal contracts. */
export function compilationAccessSetsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "action-compilation") return request;
  if (!request.schemaName.startsWith("action_compilation_") || request.promptVersion.includes(COMPILATION_ACCESS_SETS)) {
    throw new ModelConfigurationError("access-set adapter requires an unadapted compilation request");
  }
  const context = request.context;
  if (!object(context) || !object(context.task) || !Array.isArray(context.task.slots) || !context.task.slots.length ||
    context.task.slots.some(slot => !object(slot) || slot.previousAttempt !== null || !Array.isArray(slot.issues) || slot.issues.length)) {
    throw new ModelConfigurationError("access-set screen requires initial compilation slots without repair evidence");
  }
  const boundSource = sourceSignature(request);
  const wireJsonSchema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  let rewritten = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    if (object(node.properties) && Object.keys(names).some(key => Object.hasOwn(node.properties as Value, key))) {
      const fields = node.properties;
      if (!Object.keys(names).every(key => object(fields[key]) && (fields[key] as Value).type === "array") ||
        Object.values(names).some(key => Object.hasOwn(fields, key)) || !Array.isArray(node.required) ||
        !Object.keys(names).every(key => (node.required as unknown[]).includes(key))) {
        throw new ModelConfigurationError("access-set schema has incomplete or conflicting field contracts");
      }
      node.properties = Object.fromEntries(Object.entries(fields).map(([key, value]) => [names[key as keyof typeof names] ?? key, value]));
      node.required = node.required.map(key => typeof key === "string" ? names[key as keyof typeof names] ?? key : key);
      rewritten++;
    }
    if (typeof node.description === "string") node.description = translate(node.description);
    Object.values(node).forEach(visit);
  };
  visit(wireJsonSchema);
  if (!rewritten) throw new ModelConfigurationError("access-set schema contains no dependency fields");
  const boundSchema = contentHash(wireJsonSchema);
  const decode = (raw: unknown): unknown => {
    if (sourceSignature(request) !== boundSource || contentHash(wireJsonSchema) !== boundSchema) {
      throw new ModelConfigurationError("access-set source or physical schema changed");
    }
    const value = structuredClone(raw);
    if (!object(value) || !Array.isArray(value.slots)) return value;
    for (const slot of value.slots) {
      if (!object(slot) || !object(slot.interactionDependency) || !object(slot.interactionDependency.stateDependencies)) continue;
      const fields = slot.interactionDependency.stateDependencies;
      if (Object.keys(names).some(key => Object.hasOwn(fields, key)) ||
        !Object.values(names).every(key => Object.hasOwn(fields, key))) {
        throw new ModelOutputError("access-set response must use both new fields without mixed original syntax");
      }
      const reverse = Object.fromEntries(Object.entries(names).map(([original, wire]) => [wire, original]));
      slot.interactionDependency.stateDependencies = Object.fromEntries(Object.entries(fields).map(([key, value]) => [reverse[key] ?? key, value]));
    }
    return value;
  };
  const system = [translate(request.system), instruction].join("\n\n");
  return { ...request, system, userPrompt: translate(request.userPrompt), wireJsonSchema,
    schemaName: `${request.schemaName}_access_sets`, promptVersion: `${request.promptVersion}/${COMPILATION_ACCESS_SETS}`,
    jsonObjectPostlude: request.jsonObjectPostlude ? translate(request.jsonObjectPostlude) : undefined,
    preprocessOutput: raw => {
      const canonical = decode(raw);
      return request.preprocessOutput?.(canonical) ?? { value: canonical, symbolRepairs: [] };
    } };
}
