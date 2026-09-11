import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";

export const RESOLUTION_DEPENDENT_FIELDS_CODEC = "resolution-dependent-fields-v1";
const canonicalInstruction = loadPromptAsset("shared/resolution-plan-effects.md");
const wireInstruction = loadPromptAsset("shared/resolution-dependent-fields.md");
export const RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION = contentHash({
  codec: RESOLUTION_DEPENDENT_FIELDS_CODEC, canonicalInstruction, wireInstruction,
}).slice(0, 16);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Transform plan envelopes only; preserve unrelated objects and malformed fields for validation. */
function mapPlans(value: unknown, transform: (plan: Record<string, unknown>, path: (string | number)[]) => void): unknown {
  const result: unknown = structuredClone(value);
  const visit = (entry: unknown, path: (string | number)[]) => {
    if (!object(entry)) return;
    if (entry.kind === "commit_plans" && Array.isArray(entry.plans)) {
      entry.plans.forEach((plan, index) => { if (object(plan)) transform(plan, [...path, "plans", index]); });
    }
    if (Array.isArray(entry.slots)) entry.slots.forEach((slot, index) => {
      if (object(slot)) visit(slot.result, [...path, "slots", index, "result"]);
    });
  };
  visit(result, []);
  return result;
}

export function encodeResolutionDependentFields(value: unknown): unknown {
  return mapPlans(value, (plan) => {
    const magnitude = plan.primaryEffect === null ? "none"
      : object(plan.primaryEffect) ? plan.primaryEffect.magnitude : undefined;
    if (magnitude === undefined || !Object.hasOwn(plan, "baseEffect") || plan.baseEffect !== magnitude) {
      throw new Error("dependent-field encoding requires consistent canonical effect fields");
    }
    delete plan.baseEffect;
    if (object(plan.difficulty) && plan.difficulty.kind === "opposed") {
      const expected = { kind: "rating", ref: plan.difficulty.ratingRef };
      if (typeof plan.difficulty.ratingRef !== "string" || !object(plan.difficulty.source) || contentHash(plan.difficulty.source) !== contentHash(expected)) {
        throw new Error("dependent-field encoding requires opposed difficulty to cite its selected rating");
      }
      delete plan.difficulty.source;
    }
  });
}

export function decodeResolutionDependentFields(value: unknown): unknown {
  return mapPlans(value, (plan, path) => {
    const magnitude = plan.primaryEffect === null ? "none"
      : object(plan.primaryEffect) ? plan.primaryEffect.magnitude : undefined;
    if (Object.hasOwn(plan, "baseEffect") && (magnitude === undefined || plan.baseEffect !== magnitude)) {
      throw new z.ZodError([{ code: "custom", path: [...path, "baseEffect"],
        message: "baseEffect conflicts with primaryEffect.magnitude; keep exactly the intended primary magnitude" }]);
    }
    if (magnitude !== undefined) plan.baseEffect = magnitude;
    if (object(plan.difficulty) && plan.difficulty.kind === "opposed") {
      // The rating itself remains an explicit choice and must pass the normal
      // reference, target ownership and semantic checks after expansion.
      if (typeof plan.difficulty.ratingRef !== "string") return;
      const expected = { kind: "rating", ref: plan.difficulty.ratingRef };
      if (Object.hasOwn(plan.difficulty, "source") && (!object(plan.difficulty.source) || contentHash(plan.difficulty.source) !== contentHash(expected))) {
        throw new z.ZodError([{ code: "custom", path: [...path, "difficulty", "source"],
          message: "Opposed difficulty source must cite exactly its selected ratingRef" }]);
      }
      plan.difficulty.source = expected;
    }
  });
}

export function resolutionDependentFieldsWireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const wire = structuredClone(schema);
  let changed = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const properties = node.properties;
    if (object(properties) && Object.hasOwn(properties, "actionRef") &&
      Object.hasOwn(properties, "primaryEffect") && Object.hasOwn(properties, "baseEffect")) {
      // Redundant fields are optional, with exact consistency checked by the
      // decoder. Canonical input examples may contain them; copying an equal
      // value must not create an otherwise unnecessary model repair.
      if (object(properties.baseEffect)) properties.baseEffect.description = "Optional exact copy of primaryEffect.magnitude, or none when primaryEffect is null. Prefer omission.";
      if (Array.isArray(node.required)) node.required = node.required.filter(key => key !== "baseEffect");
      const visitDifficulty = (entry: unknown): void => {
        if (Array.isArray(entry)) { entry.forEach(visitDifficulty); return; }
        if (!object(entry)) return;
        const fields = entry.properties;
        if (object(fields) && object(fields.kind) && fields.kind.const === "opposed" &&
          Object.hasOwn(fields, "ratingRef") && Object.hasOwn(fields, "source")) {
          fields.source = { type: "object", additionalProperties: false,
            properties: { kind: { const: "rating", type: "string" }, ref: structuredClone(fields.ratingRef) },
            required: ["kind", "ref"], description: "Optional exact copy {kind: rating, ref: ratingRef}. Prefer omission; environment difficulty still requires its independent source." };
          if (Array.isArray(entry.required)) entry.required = entry.required.filter(key => key !== "source");
        }
        Object.values(entry).forEach(visitDifficulty);
      };
      visitDifficulty(properties.difficulty);
      const mode = object(properties.mode) ? properties.mode.const : null;
      if (mode === "blocked") {
        for (const field of ["primaryEffect", "secondaryEffect", "threatenedEffect"]) properties[field] = { type: "null" };
        properties.baseEffect = { type: "string", const: "none", description: "Optional exact copy; prefer omission." };
      } else if (mode === "check") {
        for (const field of ["primaryEffect", "threatenedEffect"]) {
          const effect = properties[field];
          if (!object(effect) || !Array.isArray(effect.anyOf) || !effect.anyOf.some(item => object(item) && item.type === "null")) {
            throw new ModelConfigurationError(`resolution ${field} nullable wire schema changed`);
          }
          const alternatives = effect.anyOf.filter(item => !object(item) || item.type !== "null");
          properties[field] = alternatives.length === 1 ? alternatives[0] : { anyOf: alternatives };
        }
        if (object(properties.means)) properties.means.minItems = 1;
      }
      changed += 1;
    }
    Object.values(node).forEach(visit);
  };
  visit(wire);
  if (!changed) throw new ModelConfigurationError("resolution wire schema contains no canonical plan magnitude");
  return wire;
}

export function dependentFieldsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || ![
    "truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch",
  ].includes(request.schemaName)) return request;
  if (request.preprocessOutput || request.wireJsonSchema) {
    throw new ModelConfigurationError("resolution dependent-fields codec cannot replace another wire codec");
  }
  if (request.system.split(canonicalInstruction).length !== 2) {
    throw new ModelConfigurationError("resolution dependent-fields instruction changed or is missing");
  }
  return {
    ...request,
    jsonExamplePolicy: "omit",
    system: request.system.replace(canonicalInstruction, wireInstruction),
    promptVersion: `${request.promptVersion}/${RESOLUTION_DEPENDENT_FIELDS_CODEC}@${RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION}`,
    wireJsonSchema: resolutionDependentFieldsWireSchema(z.toJSONSchema(request.schema, { target: "draft-07" })),
    preprocessOutput: raw => ({ value: decodeResolutionDependentFields(raw), symbolRepairs: [] }),
  };
}

/** Wrap the physical provider beneath batching so representation cannot split logical requests. */
export function dependentFieldsProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return {
    catalog: inner.catalog,
    availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(dependentFieldsRequest(request)),
  };
}
