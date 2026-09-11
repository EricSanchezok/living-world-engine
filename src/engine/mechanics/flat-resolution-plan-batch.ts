import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "./truth-batch-provider";

export const FLAT_RESOLUTION_PLAN_BATCH = "flat-resolution-plan-batch-v1";
const instruction = loadPromptAsset("shared/flat-resolution-plan-batch.md");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const configuration = (message: string): never => { throw new ModelConfigurationError(`flat plan batch: ${message}`); };
const invalid = (message: string, path: (string | number)[] = []): never => {
  throw new z.ZodError([{ code: "custom", path, message: `flat plan batch: ${message}` }]);
};
export type PlanSlotBinding = readonly (readonly string[])[];

/** Bind only exact assigned action handles from hash-verified full slot contexts. */
export function planSlotBinding(context: unknown): PlanSlotBinding {
  if (!object(context) || !isSharedBatchContext(context.state) || !object(context.task) || !Array.isArray(context.task.slots)) return configuration("missing shared slot context");
  const contexts = expandSharedBatchContexts(context.state), slots = context.task.slots;
  if (contexts.length < 2 || contexts.length !== slots.length || slots.some((entry, index) => !object(entry) || entry.slot !== index)) return configuration("task slot coverage changed");
  const seen = new Set<string>();
  return Object.freeze(contexts.map(entry => {
    const assigned = object(entry.state) && object(entry.state.actionSet) ? entry.state.actionSet.assigned : undefined;
    if (!Array.isArray(assigned) || !assigned.length) return configuration("missing assigned actions");
    return Object.freeze(assigned.map(action => {
      if (!object(action) || typeof action.actionRef !== "string" || !action.actionRef.startsWith("ref:action:") || seen.has(action.actionRef)) return configuration("ambiguous assigned action ownership");
      seen.add(action.actionRef);
      return action.actionRef;
    }));
  }));
}

function ownersFor(binding: PlanSlotBinding): Map<string, number> {
  const owners = new Map<string, number>();
  if (binding.length < 2 || binding.some(refs => !refs.length)) return configuration("incomplete action binding");
  binding.forEach((refs, slot) => refs.forEach(ref => {
    if (typeof ref !== "string" || !ref.startsWith("ref:action:") || owners.has(ref)) return configuration("ambiguous action binding");
    owners.set(ref, slot);
  }));
  return owners;
}

/** Regroup only ownership; leave every independent plan field for canonical validation. */
export function decodeFlatResolutionPlans(value: unknown, binding: PlanSlotBinding): unknown {
  const owners = ownersFor(binding);
  if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans) || Object.keys(value).some(key => !["kind", "plans"].includes(key))) return invalid("expected only kind and plans");
  const seen = new Set<string>(), groups = new Map<number, unknown[]>();
  value.plans.forEach((plan, index) => {
    if (!object(plan) || typeof plan.actionRef !== "string" || !owners.has(plan.actionRef)) return invalid("unknown assigned actionRef", ["plans", index, "actionRef"]);
    if (seen.has(plan.actionRef)) return invalid("duplicate assigned actionRef", ["plans", index, "actionRef"]);
    seen.add(plan.actionRef);
    const slot = owners.get(plan.actionRef)!, plans = groups.get(slot) ?? [];
    plans.push(structuredClone(plan)); groups.set(slot, plans);
  });
  if (seen.size !== owners.size) return invalid(`missing assigned actionRefs: ${[...owners.keys()].filter(ref => !seen.has(ref)).join(", ")}`, ["plans"]);
  return { slots: [...groups].map(([slot, plans]) => ({ slot, result: { kind: "commit_plans", plans } })) };
}

/** Inverse for complete canonical batches, including independently ordered outer slots. */
export function encodeFlatResolutionPlans(value: unknown, binding: PlanSlotBinding): unknown {
  ownersFor(binding);
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.slots)) return invalid("expected canonical slots");
  const seen = new Set<number>(), plans: unknown[] = [];
  for (const entry of value.slots) {
    if (!object(entry) || Object.keys(entry).length !== 2 || !Number.isSafeInteger(entry.slot) || typeof entry.slot !== "number" || !binding[entry.slot] || seen.has(entry.slot) ||
      !object(entry.result) || Object.keys(entry.result).length !== 2 || entry.result.kind !== "commit_plans" || !Array.isArray(entry.result.plans)) return invalid("invalid canonical slot");
    seen.add(entry.slot);
    for (const plan of entry.result.plans) {
      if (!object(plan) || typeof plan.actionRef !== "string" || !binding[entry.slot]!.includes(plan.actionRef)) return invalid("canonical plan has another slot's owner");
      plans.push(structuredClone(plan));
    }
  }
  const flat = { kind: "commit_plans", plans };
  const decoded = decodeFlatResolutionPlans(flat, binding);
  if (contentHash(decoded) !== contentHash(value)) return invalid("incomplete canonical batch");
  return flat;
}

export function flatResolutionPlanWireSchema(schema: Record<string, unknown>, binding: PlanSlotBinding): Record<string, unknown> {
  const count = ownersFor(binding).size;
  const slots = object(schema.properties) ? schema.properties.slots : undefined;
  const item = object(slots) ? slots.items : undefined;
  const result = object(item) && object(item.properties) ? item.properties.result : undefined;
  if (!object(result) || !object(result.properties) || !object(result.properties.kind) || result.properties.kind.const !== "commit_plans" ||
    !object(result.properties.plans) || result.properties.plans.type !== "array" || result.additionalProperties !== false ||
    Object.keys(result.properties).sort().join(",") !== "kind,plans") return configuration("unexpected canonical planning schema");
  const copy = structuredClone(result), fields = copy.properties as Record<string, Record<string, unknown>>;
  fields.plans = { ...fields.plans, minItems: count, maxItems: count };
  return { ...(schema.$schema ? { $schema: schema.$schema } : {}), ...copy };
}

export function flatPlanBatchRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(`/${FLAT_RESOLUTION_PLAN_BATCH}@`)) return configuration("repeated codec");
  const binding = planSlotBinding(request.context);
  if (request.userPrompt.split(SHARED_SLOT_RESULT_INSTRUCTION).length !== 2) return configuration("missing unique shared output instruction");
  const wire = flatResolutionPlanWireSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }), binding);
  return { ...request, wireJsonSchema: wire, jsonExamplePolicy: "omit",
    userPrompt: request.userPrompt.replace(SHARED_SLOT_RESULT_INSTRUCTION, instruction),
    promptVersion: `${request.promptVersion}/${FLAT_RESOLUTION_PLAN_BATCH}@${contentHash({ instruction, wire, binding }).slice(0, 16)}`,
    preprocessOutput: raw => {
      const value = decodeFlatResolutionPlans(raw, binding);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    },
  };
}

/** Install beneath other physical plan codecs, before the model adapter. */
export function flatPlanBatchProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(flatPlanBatchRequest(request)),
  };
}
