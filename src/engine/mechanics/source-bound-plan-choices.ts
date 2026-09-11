import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

export const SOURCE_BOUND_PLAN_CHOICES = "source-bound-plan-choices-v1";
const instruction = loadPromptAsset("shared/source-bound-plan-choices.md");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`source-bound plan choices: ${message}`); };
export interface PlanChoiceDomains { actionRefs: string[]; targetSelectors: string[] }

/** Enumerate existing choices only; a root union never grants another slot's permissions. */
export function planChoiceDomains(context: unknown): PlanChoiceDomains {
  if (!object(context)) return fail("missing context");
  const shared = isSharedBatchContext(context.state) ? context.state : null;
  const contexts = shared ? expandSharedBatchContexts(shared) : [context];
  if (shared && (!object(context.task) || !Array.isArray(context.task.slots) || context.task.slots.length !== contexts.length ||
    context.task.slots.some((entry, index) => !object(entry) || entry.slot !== index))) return fail("invalid shared task binding");
  const actions = new Set<string>(), targets = new Map<string, string>();
  for (const entry of contexts) {
    const assigned = object(entry.state) && object(entry.state.actionSet) ? entry.state.actionSet.assigned : undefined;
    const catalog = object(entry.referenceCatalog) ? entry.referenceCatalog.candidates : undefined;
    if (!Array.isArray(assigned) || !assigned.length || !Array.isArray(catalog)) return fail("missing complete assigned or target inventory");
    for (const action of assigned) {
      if (!object(action) || typeof action.actionRef !== "string" || !action.actionRef.startsWith("ref:action:") || actions.has(action.actionRef)) return fail("ambiguous assigned action");
      actions.add(action.actionRef);
    }
    for (const candidate of catalog) {
      if (!object(candidate) || !Array.isArray(candidate.allowedUses)) return fail("invalid catalog record");
      if (candidate.kind !== "entity" || !candidate.allowedUses.includes("target")) continue;
      if (typeof candidate.handle !== "string" || !candidate.handle.startsWith("ref:entity:") || typeof candidate.targetSelector !== "string" ||
        candidate.targetSelector !== `e:${contentHash(candidate.handle).slice(0, 12)}` ||
        (targets.has(candidate.targetSelector) && targets.get(candidate.targetSelector) !== candidate.handle)) return fail("invalid source selector binding");
      targets.set(candidate.targetSelector, candidate.handle);
    }
  }
  return { actionRefs: [...actions].sort(), targetSelectors: [...targets.keys()].sort() };
}

export function sourceBoundPlanChoiceSchema(schema: Record<string, unknown>, domains: PlanChoiceDomains): Record<string, unknown> {
  if (!domains.actionRefs.length || new Set(domains.actionRefs).size !== domains.actionRefs.length ||
    new Set(domains.targetSelectors).size !== domains.targetSelectors.length || domains.actionRefs.some(ref => !ref.startsWith("ref:action:")) ||
    domains.targetSelectors.some(ref => !/^e:[0-9a-f]{12}$/u.test(ref))) return fail("invalid choice domain");
  const copy = structuredClone(schema), definitions = object(copy.definitions) ? copy.definitions : {};
  if (copy.definitions !== undefined && !object(copy.definitions)) return fail("invalid schema definitions");
  const actionKey = "source_bound_plan_action", targetKey = "source_bound_plan_target";
  if (Object.hasOwn(definitions, actionKey) || Object.hasOwn(definitions, targetKey)) return fail("repeated schema binding");
  let actionContract: unknown, targetContract: unknown, changed = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && ["actionRef", "mode", "targetRefs", "means", "causes", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
      const action = fields.actionRef, targets = fields.targetRefs;
      if (!object(action) || !object(targets) || !object(targets.items) || targets.items.pattern !== "^e:[0-9a-f]{12}$" ||
        !z.fromJSONSchema(action).safeParse(domains.actionRefs[0]).success) return fail("unexpected plan choice schema");
      if (changed && (contentHash(actionContract) !== contentHash(action) || contentHash(targetContract) !== contentHash(targets.items))) return fail("inconsistent plan choice alternatives");
      actionContract = structuredClone(action); targetContract = structuredClone(targets.items);
      fields.actionRef = { $ref: `#/definitions/${actionKey}` };
      targets.items = { $ref: `#/definitions/${targetKey}` };
      changed++;
    }
    Object.values(node).forEach(visit);
  };
  visit(copy);
  if (!changed || !object(actionContract) || !object(targetContract)) return fail("missing plan selector schema");
  definitions[actionKey] = { ...actionContract, enum: [...domains.actionRefs] };
  // An impossible item still permits an empty targetRefs list. Use the object
  // form because the local schema converter cannot resolve a false-valued ref.
  definitions[targetKey] = domains.targetSelectors.length ? { ...targetContract, enum: [...domains.targetSelectors] } : { not: {} };
  copy.definitions = definitions;
  return copy;
}

export function sourceBoundPlanChoicesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(`/${SOURCE_BOUND_PLAN_CHOICES}@`)) return fail("repeated codec");
  const domains = planChoiceDomains(request.context);
  const wire = sourceBoundPlanChoiceSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }), domains);
  return { ...request, wireJsonSchema: wire, jsonExamplePolicy: "omit",
    userPrompt: [request.userPrompt, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${SOURCE_BOUND_PLAN_CHOICES}@${contentHash({ instruction, wire, domains }).slice(0, 16)}`,
  };
}

export function sourceBoundPlanChoicesProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(sourceBoundPlanChoicesRequest(request)),
  };
}
