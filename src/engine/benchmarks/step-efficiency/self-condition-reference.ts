import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { proposalKeySchema } from "../../contracts/model-context";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = ["primaryEffect", "secondaryEffect", "threatenedEffect"];
const canonical = loadPromptAsset("shared/resolution-condition-references.md");
const instruction = loadPromptAsset("shared/self-condition-reference.md");
export const SELF_CONDITION_REFERENCE = `self-condition-reference-v1@${contentHash({ canonical, instruction }).slice(0, 16)}`;
const fail = (message: string): never => { throw new ModelConfigurationError(`self-condition reference: ${message}`); };

/** Visit current output envelopes only; historical and unrelated objects are not generation choices. */
function mapEffects(raw: unknown, transform: (effect: Value) => void): unknown {
  const value = structuredClone(raw);
  const visit = (entry: unknown): void => {
    if (!object(entry)) return;
    if (entry.kind === "commit_plans" && Array.isArray(entry.plans)) for (const plan of entry.plans) {
      if (object(plan)) for (const field of fields) {
        const effect = plan[field];
        if (object(effect) && effect.kind === "condition") transform(effect);
      }
    }
    if (Array.isArray(entry.slots)) for (const slot of entry.slots) if (object(slot)) visit(slot.result);
  };
  visit(value);
  return value;
}

export function encodeSelfConditionReference(raw: unknown): unknown {
  return mapEffects(raw, effect => {
    const ref = effect.conditionRef;
    if (proposalKeySchema.safeParse(effect.proposalKey).success && object(ref) &&
      Object.keys(ref).length === 1 && ref.proposalKey === effect.proposalKey) effect.conditionRef = null;
  });
}

export function decodeSelfConditionReference(raw: unknown): unknown {
  return mapEffects(raw, effect => {
    if (effect.conditionRef === null && proposalKeySchema.safeParse(effect.proposalKey).success) {
      effect.conditionRef = { proposalKey: effect.proposalKey };
    }
  });
}

function wireSchema(source: Value): Value {
  const result = structuredClone(source); let changed = 0;
  const effect = (node: unknown): void => {
    if (!object(node)) return;
    for (const union of ["anyOf", "oneOf"]) if (Array.isArray(node[union])) node[union].forEach(effect);
    const properties = node.properties;
    if (object(properties) && object(properties.kind) && properties.kind.const === "condition") {
      if (!object(properties.conditionRef) || !object(properties.proposalKey) || !Array.isArray(node.required) ||
        !node.required.includes("conditionRef") || !node.required.includes("proposalKey")) return fail("unsupported condition schema");
      properties.conditionRef = { anyOf: [properties.conditionRef, { type: "null" }],
        description: "Null explicitly references this effect's own proposalKey. Existing handles and explicit declaration references retain their exact meaning." };
      changed++;
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const properties = node.properties;
    if (object(properties) && (Object.hasOwn(properties, "actionIndex") || Object.hasOwn(properties, "actionRef")) &&
      Object.hasOwn(properties, "primaryEffect")) { for (const field of fields) effect(properties[field]); return; }
    Object.values(node).forEach(visit);
  };
  visit(result);
  if (!changed) return fail("missing condition effect schemas");
  return result;
}

/** Apply after physical planning codecs; canonical schema and preprocessors remain authoritative. */
export function selfConditionReferenceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(SELF_CONDITION_REFERENCE)) return fail("already applied");
  if (!request.wireJsonSchema) return fail("missing wire schema");
  const replace = (text: string | undefined): string => {
    if (text?.split(canonical).length !== 2) return fail("requires one canonical instruction in system and tail");
    return text.replace(canonical, instruction);
  };
  const wireJsonSchema = wireSchema(request.wireJsonSchema), system = replace(request.system);
  if (!request.jsonObjectPostlude || request.jsonObjectPostlude.includes(canonical) || request.jsonObjectPostlude.includes(instruction)) {
    return fail("requires original planning tail without condition instructions; check system and tail");
  }
  const jsonObjectPostlude = `${request.jsonObjectPostlude}\n\n${instruction}`;
  const binding = (value: StructuredModelRequest<T>) => contentHash({ context: value.context, wireJsonSchema: value.wireJsonSchema,
    system: value.system, userPrompt: value.userPrompt, jsonObjectPostlude: value.jsonObjectPostlude, promptVersion: value.promptVersion });
  const originalHash = binding(request);
  const candidate: StructuredModelRequest<T> = { ...request, wireJsonSchema, system, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${SELF_CONDITION_REFERENCE}@${contentHash({ wireJsonSchema, system, jsonObjectPostlude }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (binding(request) !== originalHash || binding(candidate) !== candidateHash) return fail("source, schema or instruction changed before decoding");
      const value = decodeSelfConditionReference(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
  const candidateHash = binding(candidate);
  return candidate;
}
