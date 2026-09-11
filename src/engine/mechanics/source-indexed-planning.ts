import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { assertPhysicalPlanningWorklist, type PhysicalPlanningWorklist } from "./physical-planning-worklist";

export const SOURCE_INDEXED_PLANNING = "source-indexed-planning-v1";
const instruction = loadPromptAsset("shared/source-indexed-planning.md");
const selectorClause = "Each means.source remains the exact sourceSelector from this action's allowedMeansSources. Never borrow another action's means selector.";
const meansInstruction = "Each means emits sourcePosition instead of source. Select the explicit sourcePosition from THIS actionIndex's complete allowedMeansSources list; positions are local to that action, not global cause or target indices. The decoder restores exactly that entry's sourceSelector and kind/ref. Preserve each means description, order, repetitions and supporting evidence. Do not emit source or guess a missing position. All original sources remain available; the engine does not select one for you. In repair, use the CURRENT action's positions, never positions copied from a different action or previous request.";
export const SOURCE_INDEXED_PLAN_MEANS = `action-local-means-indices-v1@${contentHash(meansInstruction).slice(0, 16)}`;
const replacedInstructions = ["shared/physical-planning-worklist.md", "shared/source-bound-plan-choices.md"];
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`indexed planning: ${message}`); };
const invalid = (message: string, path: (string | number)[] = []): never => {
  throw new z.ZodError([{ code: "custom", path, message: `indexed planning: ${message}` }]);
};
export interface PlanningIndexDomain {
  actions: Array<{ handle: string; slot: number; means?: Array<{ sourceSelector: string; kind: string; ref: string }> }>;
  targets: Array<{ handle: string; selector: string; slots: number[] }>;
}

export function planningIndexDomain(context: unknown, indexMeans = false): PlanningIndexDomain {
  assertPhysicalPlanningWorklist(context);
  const worklist = (context as { task: { planningWorklist: PhysicalPlanningWorklist } }).task.planningWorklist;
  const targets: PlanningIndexDomain["targets"] = [];
  for (const row of worklist.targetChoices) {
    const target = targets.find(target => target.handle === row.handle);
    if (target) target.slots = [...new Set([...target.slots, ...row.slots])];
    else targets.push({ handle: row.handle, selector: row.targetSelector, slots: [...row.slots] });
  }
  const actions = worklist.actions.map(row => {
    const handle = row.action.actionRef as string;
    if (!indexMeans) return { handle, slot: row.slot };
    if (!Array.isArray(row.action.allowedMeansSources)) return fail("missing complete means inventory");
    const means = row.action.allowedMeansSources.map(source => {
      if (!object(source) || typeof source.kind !== "string" || typeof source.ref !== "string" ||
        source.sourceSelector !== `m:${contentHash({ actionRef: handle, source: { kind: source.kind, ref: source.ref } }).slice(0, 12)}`) return fail("invalid means source binding");
      return { kind: source.kind, ref: source.ref, sourceSelector: source.sourceSelector as string };
    });
    return { handle, slot: row.slot, means };
  });
  return { actions, targets };
}

export function indexPlanningContext(context: unknown, indexMeans = false): Record<string, unknown> {
  const domain = planningIndexDomain(context, indexMeans), copy = structuredClone(context) as Record<string, unknown>;
  const task = copy.task as Record<string, unknown>, worklist = task.planningWorklist as PhysicalPlanningWorklist;
  if (Object.hasOwn(task, "planningIndices")) return fail("repeated context projection");
  worklist.actions.forEach((row, actionIndex) => {
    if (Object.hasOwn(row, "actionIndex")) fail("source contains action index");
    Object.assign(row, { actionIndex });
    if (indexMeans) (row.action.allowedMeansSources as Record<string, unknown>[]).forEach((source, sourcePosition) => {
      if (Object.hasOwn(source, "sourcePosition")) fail("source contains means position");
      source.sourcePosition = sourcePosition;
    });
  });
  worklist.targetChoices.forEach(row => {
    if (Object.hasOwn(row, "targetIndex")) fail("source contains target index");
    Object.assign(row, { targetIndex: domain.targets.findIndex(target => target.handle === row.handle) });
  });
  task.planningIndices = { contract: SOURCE_INDEXED_PLANNING, sourceContextHash: contentHash(context),
    actionCount: domain.actions.length, targetCount: domain.targets.length,
    ...(indexMeans ? { meansContract: SOURCE_INDEXED_PLAN_MEANS } : {}) };
  return copy;
}

export function withoutPlanningIndices(context: unknown): Record<string, unknown> {
  const copy = structuredClone(context);
  if (!object(copy) || !object(copy.task) || !object(copy.task.planningIndices) || !object(copy.task.planningWorklist)) return fail("missing indexed context");
  const worklist = copy.task.planningWorklist;
  if (!Array.isArray(worklist.actions) || !Array.isArray(worklist.targetChoices)) return fail("missing worklist rows");
  for (const row of worklist.actions) {
    if (!object(row)) return fail("invalid action row"); delete row.actionIndex;
    if (copy.task.planningIndices.meansContract === SOURCE_INDEXED_PLAN_MEANS && object(row.action) && Array.isArray(row.action.allowedMeansSources)) {
      for (const source of row.action.allowedMeansSources) if (object(source)) delete source.sourcePosition;
    }
  }
  for (const row of worklist.targetChoices) { if (!object(row)) return fail("invalid target row"); delete row.targetIndex; }
  delete copy.task.planningIndices;
  return copy;
}

export function assertIndexedPlanningContext(context: unknown): void {
  const indexedMeans = object(context) && object(context.task) && object(context.task.planningIndices) && context.task.planningIndices.meansContract === SOURCE_INDEXED_PLAN_MEANS;
  if (contentHash(indexPlanningContext(withoutPlanningIndices(context), indexedMeans)) !== contentHash(context)) fail("source or index binding changed");
}

const atIndex = <T>(values: readonly T[], index: unknown): T | undefined =>
  typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? values[index] : undefined;

/** Restore reference relationships only; canonical slot validators retain invalid neighbors. */
export function decodeIndexedPlans(raw: unknown, domain: PlanningIndexDomain): unknown {
  const value = structuredClone(raw);
  if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("expected flat plans");
  const seen = new Set<number>();
  for (const [ordinal, plan] of value.plans.entries()) {
    if (!object(plan)) return invalid("invalid plan", ["plans", ordinal]);
    if (Object.hasOwn(plan, "actionRef") || Object.hasOwn(plan, "targetRefs")) return invalid("mixed reference representations", ["plans", ordinal]);
    const action = atIndex(domain.actions, plan.actionIndex);
    if (!action || seen.has(plan.actionIndex as number)) return invalid("unknown or duplicate actionIndex", ["plans", ordinal, "actionIndex"]);
    seen.add(plan.actionIndex as number);
    if (action.means && Array.isArray(plan.means)) for (const mean of plan.means) {
      if (!object(mean)) continue;
      if (Object.hasOwn(mean, "source")) { mean.invalidMeansPosition = { reason: "mixed means representations", rejectedSources: action.means }; continue; }
      const source = atIndex(action.means, mean.sourcePosition);
      mean.source = source?.sourceSelector ?? `unresolved-source-position:${JSON.stringify(mean.sourcePosition)}`;
      if (!source) mean.invalidMeansPosition = { rejectedPosition: mean.sourcePosition, rejectedSources: action.means };
      delete mean.sourcePosition;
    }
    const indices = plan.targetIndices;
    const selected = Array.isArray(indices) ? indices.map(index => {
      const target = atIndex(domain.targets, index);
      return target?.slots.includes(action.slot) ? target : undefined;
    }) : [];
    plan.actionRef = action.handle; delete plan.actionIndex;
    plan.targetRefs = Array.isArray(indices) ? indices.map((index, i) => selected[i]?.selector ?? `unresolved-index:${JSON.stringify(index)}`) : indices;
    delete plan.targetIndices;
    for (const field of ["primaryEffect", "secondaryEffect", "threatenedEffect"]) {
      const effect = plan[field]; if (!object(effect)) continue;
      if (Object.hasOwn(effect, "targetRef")) return invalid("mixed effect reference representations", ["plans", ordinal, field]);
      effect.targetRef = atIndex(selected, effect.targetPosition)?.handle ?? `unresolved-index:${JSON.stringify(effect.targetPosition)}`;
      delete effect.targetPosition;
    }
  }
  if (seen.size !== domain.actions.length) return invalid(`missing actionIndex values: ${domain.actions.flatMap((_, i) => seen.has(i) ? [] : [i]).join(", ")}`, ["plans"]);
  return value;
}

/** Canonical round trip includes target order and repeated target references. */
export function encodeIndexedPlans(raw: unknown, domain: PlanningIndexDomain): unknown {
  const value = structuredClone(raw);
  if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("expected flat plans");
  for (const [ordinal, plan] of value.plans.entries()) {
    if (!object(plan) || Object.hasOwn(plan, "actionIndex") || Object.hasOwn(plan, "targetIndices") || !Array.isArray(plan.targetRefs)) return invalid("invalid source plan", ["plans", ordinal]);
    plan.actionIndex = domain.actions.findIndex(action => action.handle === plan.actionRef); delete plan.actionRef;
    const action = atIndex(domain.actions, plan.actionIndex);
    if (action?.means && Array.isArray(plan.means)) for (const mean of plan.means) {
      if (!object(mean) || Object.hasOwn(mean, "sourcePosition")) return invalid("mixed means representations", ["plans", ordinal, "means"]);
      mean.sourcePosition = action.means.findIndex(source => source.sourceSelector === mean.source); delete mean.source;
    }
    const indices = plan.targetRefs.map(selector => domain.targets.findIndex(target => target.selector === selector));
    plan.targetIndices = indices; delete plan.targetRefs;
    for (const field of ["primaryEffect", "secondaryEffect", "threatenedEffect"]) {
      const effect = plan[field]; if (!object(effect)) continue;
      if (Object.hasOwn(effect, "targetPosition")) return invalid("mixed effect representations", ["plans", ordinal, field]);
      const position = indices.findIndex(index => domain.targets[index]?.handle === effect.targetRef);
      if (position < 0) return invalid("effect subject absent from selected plan targets", ["plans", ordinal, field, "targetRef"]);
      effect.targetPosition = position; delete effect.targetRef;
    }
  }
  if (contentHash(decodeIndexedPlans(value, domain)) !== contentHash(raw)) return invalid("source cannot round trip");
  return value;
}

export function indexedPlanningWireSchema(schema: Record<string, unknown>, domain: PlanningIndexDomain): Record<string, unknown> {
  const copy = structuredClone(schema); let plans = 0, effects = 0;
  const rename = (node: Record<string, unknown>, fields: Record<string, unknown>, from: string, to: string, replacement: unknown): void => {
    if (!Array.isArray(node.required) || !node.required.includes(from) || Object.hasOwn(fields, to)) return fail("unexpected field contract");
    fields[to] = replacement; delete fields[from]; node.required = node.required.map(key => key === from ? to : key);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; } if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && ["actionRef", "mode", "targetRefs", "means", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
      if (!object(fields.targetRefs) || !domain.actions.length) return fail("missing plan domain");
      rename(node, fields, "actionRef", "actionIndex", { type: "integer", minimum: 0, maximum: domain.actions.length - 1 });
      rename(node, fields, "targetRefs", "targetIndices", { ...fields.targetRefs,
        description: "Select targetIndex values from the complete worklist, within this action's source slot.",
        items: domain.targets.length ? { type: "integer", minimum: 0, maximum: domain.targets.length - 1 } : { not: {} } });
      if (domain.actions.some(action => action.means !== undefined)) {
        const means = fields.means;
        if (!object(means) || !object(means.items) || !object(means.items.properties) || !object(means.items.properties.source) || means.items.properties.source.pattern !== "^m:[0-9a-f]{12}$") return fail("unexpected means selector schema");
        const count = Math.max(...domain.actions.map(action => action.means?.length ?? 0));
        rename(means.items, means.items.properties, "source", "sourcePosition", count ? { type: "integer", minimum: 0, maximum: count - 1,
          description: "Select sourcePosition from this action's complete allowedMeansSources, not another action or global index domain." } : { not: {} });
      }
      plans++;
    } else if (object(fields) && ["targetRef", "sourceRefs", "channel", "proposalKey"].every(key => Object.hasOwn(fields, key))) {
      rename(node, fields, "targetRef", "targetPosition", { type: "integer", minimum: 0,
        description: "Position in this plan's targetIndices, not a global targetIndex." }); effects++;
    }
    Object.values(node).forEach(visit);
  };
  visit(copy);
  if (!plans || !effects || !object(copy.properties) || !object(copy.properties.plans)) return fail("missing flat plan schema");
  copy.properties.plans.minItems = domain.actions.length; copy.properties.plans.maxItems = domain.actions.length;
  // These definitions have no remaining references after every plan alternative is rewritten.
  if (object(copy.definitions)) for (const key of ["source_bound_plan_action", "source_bound_plan_target"]) {
    if (JSON.stringify(copy.properties).includes(`#/definitions/${key}`)) return fail("remaining source choice reference");
    delete copy.definitions[key];
  }
  return copy;
}

export function sourceIndexedPlanningInstruction(indexMeans = false): string {
  if (indexMeans && instruction.split(selectorClause).length !== 2) return fail("missing means selector instruction");
  return indexMeans ? instruction.replace(selectorClause, meansInstruction) : instruction;
}

export function sourceIndexedPlanningRequest<T>(request: StructuredModelRequest<T>, indexMeans = false): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(`/${SOURCE_INDEXED_PLANNING}@`)) return fail("repeated codec");
  const domain = planningIndexDomain(request.context, indexMeans), context = indexPlanningContext(request.context, indexMeans);
  assertIndexedPlanningContext(context);
  const wire = indexedPlanningWireSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }), domain);
  let userPrompt = request.userPrompt;
  const selectorInstruction = loadPromptAsset("shared/plan-source-selectors.md");
  if (request.system.split(selectorInstruction).length !== 2) return fail("missing unique selector system instruction");
  const selectedInstruction = sourceIndexedPlanningInstruction(indexMeans);
  const system = request.system.replace(selectorInstruction, selectedInstruction);
  const assets = [...replacedInstructions, ...(request.schemaName.endsWith("_batch") ? ["shared/flat-resolution-plan-batch.md"] : [])];
  for (const asset of assets) {
    const text = loadPromptAsset(asset);
    if (userPrompt.split(text).length !== 2) return fail(`missing unique replaced instruction ${asset}`);
    userPrompt = userPrompt.replace(text, "");
  }
  return { ...request, context, wireJsonSchema: wire, userPrompt, system, jsonExamplePolicy: "omit",
    promptVersion: `${request.promptVersion}/${SOURCE_INDEXED_PLANNING}@${contentHash({ instruction: selectedInstruction, wire, domain, context }).slice(0, 16)}${indexMeans ? `/${SOURCE_INDEXED_PLAN_MEANS}` : ""}`,
    preprocessOutput: raw => {
      try {
        const value = decodeIndexedPlans(raw, domain);
        return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
      } catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        // A physical failure can retain the undecoded candidate. Carry its
        // exact index vocabulary into repair even if the next scope changes.
        const binding = JSON.stringify({ actions: domain.actions.map(action => action.handle), targets: domain.targets.map(target => target.handle),
          ...(indexMeans ? { means: domain.actions.map(action => ({ actionRef: action.handle, sources: action.means })) } : {}) });
        throw new z.ZodError(error.issues.map(issue => ({ ...issue,
          message: `${issue.message}. Index arrays for the rejected request only: ${binding}. Resolve its indices to these handles, then select indices from the CURRENT worklist.`,
        })));
      }
    },
  };
}

export function sourceIndexedPlanningProvider(inner: StructuredModelProvider, indexMeans = false): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(sourceIndexedPlanningRequest(request, indexMeans)),
  };
}
