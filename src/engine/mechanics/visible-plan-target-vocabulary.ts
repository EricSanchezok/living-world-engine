import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

export const VISIBLE_PLAN_TARGET_VOCABULARY = "visible-plan-targets-v1";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Only current, hash-bound catalog membership contributes; world prose and
 * other slots' outputs are never sources of selectable target identities. */
export function visiblePlanTargetHandles(context: unknown): string[] {
  if (!record(context)) throw new ModelConfigurationError("plan target vocabulary requires an object context");
  const contexts = isSharedBatchContext(context.state) ? expandSharedBatchContexts(context.state) : [context];
  const targets = new Set<string>();
  for (const slot of contexts) {
    const catalog = slot.referenceCatalog;
    if (!record(catalog) || !Array.isArray(catalog.candidates)) throw new ModelConfigurationError("plan target vocabulary requires each slot's complete catalog");
    for (const candidate of catalog.candidates) {
      if (!record(candidate) || typeof candidate.handle !== "string" || !Array.isArray(candidate.allowedUses)) throw new ModelConfigurationError("invalid plan target candidate");
      if (candidate.kind !== "entity" || !candidate.allowedUses.includes("target")) continue;
      if (!candidate.handle.startsWith("ref:entity:")) throw new ModelConfigurationError("plan target candidate kind mismatch");
      targets.add(candidate.handle);
    }
  }
  return [...targets].sort();
}

export function visiblePlanTargetRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || ![
    "truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch",
  ].includes(request.schemaName)) return request;
  const targets = visiblePlanTargetHandles(request.context);
  const wire = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  let changed = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!record(node)) return;
    const fields = node.properties;
    if (record(fields) && ["actionRef", "mode", "targetRefs", "primaryEffect", "causes"].every(key => Object.hasOwn(fields, key))) {
      const refs = fields.targetRefs;
      if (!record(refs) || refs.type !== "array" || !record(refs.items) || refs.items.type !== "string" || refs.items.pattern !== "^ref:entity:") {
        throw new ModelConfigurationError("canonical plan target schema changed");
      }
      if (targets.length) refs.items = { ...refs.items, enum: targets };
      else refs.maxItems = 0;
      refs.description = "Copy exact target-eligible entity handles from this vocabulary and the current slot's reconstructed catalog. The vocabulary is the union across physical slots; it grants no cross-slot authority. Select every target justified by the original action; never invent a handle or drop an intended target to avoid validation.";
      changed++;
    }
    Object.values(node).forEach(visit);
  };
  visit(wire);
  if (!changed) throw new ModelConfigurationError("plan target schema contains no recognized plan");
  return { ...request, wireJsonSchema: wire,
    promptVersion: `${request.promptVersion}/${VISIBLE_PLAN_TARGET_VOCABULARY}@${contentHash(wire).slice(0, 16)}` };
}

/** Place beneath batching and beneath any wire representation adapter. */
export function visiblePlanTargetProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    generateStructured: request => inner.generateStructured(visiblePlanTargetRequest(request)),
  };
}
