import { z } from "zod";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { expandSharedBatchContexts, factorSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

export const PLAN_SOURCE_SELECTORS = "plan-source-selectors-v1";
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`plan selectors: ${message}`); };
const selector = (prefix: string, value: unknown) => `${prefix}:${contentHash(value).slice(0, 12)}`;
type Source = { kind: string; ref: string };
type Domain = { targets: Map<string, string>; means: Map<string, Map<string, Source>> };
const instruction = loadPromptAsset("shared/plan-source-selectors.md");

function insert<T>(map: Map<string, T>, id: string, value: T): void {
  if (map.has(id) && contentHash(map.get(id)) !== contentHash(value)) fail("selector collision");
  map.set(id, value);
}

/** Annotate copies of exact input records, without interpreting their prose. */
function annotate(context: Record<string, unknown>, bindings: Map<string, unknown>): Domain {
  const catalog = context.referenceCatalog;
  if (!object(catalog) || !Array.isArray(catalog.candidates)) return fail("missing complete catalog");
  const domain: Domain = { targets: new Map(), means: new Map() };
  for (const entry of catalog.candidates) {
    if (!object(entry) || !Array.isArray(entry.allowedUses)) fail("invalid catalog entry");
    if (Object.hasOwn(entry, "targetSelector")) fail("source already contains target annotation");
    if (entry.kind !== "entity" || !entry.allowedUses.includes("target")) continue;
    if (typeof entry.handle !== "string" || !entry.handle.startsWith("ref:entity:")) fail("target kind mismatch");
    const id = selector("e", entry.handle);
    insert(bindings, id, entry.handle);
    insert(domain.targets, id, entry.handle);
    entry.targetSelector = id;
  }
  const state = context.state, actionSet = object(state) ? state.actionSet : undefined;
  if (!object(actionSet) || !Array.isArray(actionSet.assigned)) return fail("missing assigned action inventory");
  for (const action of actionSet.assigned) {
    if (!object(action) || typeof action.actionRef !== "string" || !Array.isArray(action.allowedMeansSources)) fail("missing action source inventory");
    if (domain.means.has(action.actionRef)) fail("duplicate assigned action");
    const choices = new Map<string, Source>();
    for (const source of action.allowedMeansSources) {
      if (!object(source) || typeof source.kind !== "string" || typeof source.ref !== "string" || Object.hasOwn(source, "sourceSelector")) fail("invalid source inventory entry");
      const pair = { kind: source.kind, ref: source.ref };
      const id = selector("m", { actionRef: action.actionRef, source: pair });
      insert(bindings, id, { actionRef: action.actionRef, source: pair });
      insert(choices, id, pair);
      source.sourceSelector = id;
    }
    domain.means.set(action.actionRef, choices);
  }
  return domain;
}

function mapPlans(value: unknown, domains: Domain[], encode: boolean): unknown {
  const copy: unknown = structuredClone(value);
  const visit = (entry: unknown, domain: Domain | undefined): void => {
    if (!object(entry)) return;
    if (Array.isArray(entry.slots)) for (const slot of entry.slots) {
      if (object(slot)) visit(slot.result, typeof slot.slot === "number" && Number.isInteger(slot.slot) ? domains[slot.slot] : undefined);
    }
    if (entry.kind !== "commit_plans" || !Array.isArray(entry.plans)) return;
    for (const plan of entry.plans) {
      if (!object(plan)) continue;
      const choices = typeof plan.actionRef === "string" ? domain?.means.get(plan.actionRef) : undefined;
      if (Array.isArray(plan.targetRefs)) plan.targetRefs = plan.targetRefs.map((value: unknown) => {
        if (encode) {
          if (typeof value === "string" && value.startsWith("unresolved-selection:")) {
            try { return JSON.parse(value.slice("unresolved-selection:".length)); } catch { return value; }
          }
          return [...(domain?.targets ?? [])].find(([, ref]) => ref === value)?.[0] ?? value;
        }
        // Keep invalid selections invalid in the canonical schema while still
        // expanding every independent valid field and physical slot.
        return typeof value === "string" && domain?.targets.has(value)
          ? domain.targets.get(value) : `unresolved-selection:${JSON.stringify(value)}`;
      });
      if (Array.isArray(plan.means)) for (const means of plan.means) {
        if (!object(means) || !Object.hasOwn(means, "source")) continue;
        if (encode) {
          if (object(means.source) && Object.hasOwn(means.source, "unresolvedSelection")) means.source = means.source.unresolvedSelection;
          else means.source = [...(choices ?? [])].find(([, source]) => contentHash(source) === contentHash(means.source))?.[0] ?? means.source;
        } else means.source = typeof means.source === "string" && choices?.has(means.source)
          ? structuredClone(choices.get(means.source)) : { unresolvedSelection: means.source };
      }
    }
  };
  visit(copy, domains.length === 1 ? domains[0] : undefined);
  return copy;
}

function encodeRepair(value: unknown, domains: Domain[]): unknown {
  if (Array.isArray(value)) return value.map(entry => encodeRepair(entry, domains));
  if (!object(value)) return value;
  if (value.kind === "commit_plans" || Array.isArray(value.slots)) return mapPlans(value, domains, true);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeRepair(entry, domains)]));
}

/** Strips only codec-owned annotations; source facts and repair evidence stay intact. */
export function stripPlanSelectorAnnotations(context: unknown): unknown {
  const copy = structuredClone(context);
  if (!object(copy)) return copy;
  if (isSharedBatchContext(copy.state)) {
    copy.state = factorSharedBatchContexts(expandSharedBatchContexts(copy.state).map(stripPlanSelectorAnnotations), copy.state.codec);
    return copy;
  }
  const catalog = copy.referenceCatalog;
  if (object(catalog) && Array.isArray(catalog.candidates)) for (const entry of catalog.candidates) if (object(entry)) delete entry.targetSelector;
  const state = copy.state, actions = object(state) && object(state.actionSet) ? state.actionSet.assigned : undefined;
  if (Array.isArray(actions)) for (const action of actions) if (object(action) && Array.isArray(action.allowedMeansSources)) {
    for (const source of action.allowedMeansSources) if (object(source)) delete source.sourceSelector;
  }
  return copy;
}

/** Restore one logical candidate with the same selector decoder used by live output. */
export function decodeLogicalPlanSelectors(value: unknown, context: unknown): unknown {
  const source = stripPlanSelectorAnnotations(context);
  if (!object(source) || isSharedBatchContext(source.state)) return fail("requires one logical source");
  return mapPlans(value, [annotate(source, new Map())], false);
}

function wireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(schema);
  let changed = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && ["actionRef", "mode", "targetRefs", "means", "causes", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
      const refs = fields.targetRefs, means = fields.means;
      if (!object(refs) || !object(refs.items) || refs.items.pattern !== "^ref:entity:" || !object(means) || !object(means.items) || !object(means.items.properties)) return fail("canonical plan schema changed");
      refs.items = { type: "string", pattern: "^e:[0-9a-f]{12}$" };
      refs.description = "Select exact targetSelector strings from this slot's target-eligible entity catalog. Preserve all intended targets.";
      means.items.properties.source = { type: "string", pattern: "^m:[0-9a-f]{12}$", description: "Select sourceSelector from this plan.actionRef's allowedMeansSources; that exact kind/ref must support the means description." };
      changed++;
    }
    Object.values(node).forEach(visit);
  };
  visit(copy);
  if (!changed) fail("missing plan wire schema");
  return copy;
}

export function planSelectorRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  const context = structuredClone(request.context);
  if (!object(context)) return fail("missing request context");
  const shared = isSharedBatchContext(context.state) ? context.state : null;
  const contexts = shared ? expandSharedBatchContexts(shared) : [context];
  const bindings = new Map<string, unknown>();
  const domains = contexts.map(slot => annotate(slot, bindings));
  for (const [index, slot] of contexts.entries()) if (slot.repair !== undefined) slot.repair = encodeRepair(slot.repair, [domains[index]!]);
  if (shared) context.state = factorSharedBatchContexts(contexts, shared.codec);
  if (context.batchRepair !== undefined) context.batchRepair = encodeRepair(context.batchRepair, domains);
  const wire = wireSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  return { ...request, context, wireJsonSchema: wire, jsonExamplePolicy: "omit",
    system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${PLAN_SOURCE_SELECTORS}@${contentHash({ instruction, wire }).slice(0, 16)}`,
    preprocessOutput: raw => {
      const value = mapPlans(raw, domains, false);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    },
  };
}

/** Place below batching, after dependent-field request encoding. */
export function planSelectorProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(planSelectorRequest(request)),
  };
}
