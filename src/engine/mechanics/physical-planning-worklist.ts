import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";
import { planChoiceDomains } from "./source-bound-plan-choices";

export const PHYSICAL_PLANNING_WORKLIST = "physical-planning-worklist-v1";
const instruction = loadPromptAsset("shared/physical-planning-worklist.md");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`planning worklist: ${message}`); };
export interface PhysicalPlanningWorklist {
  contract: typeof PHYSICAL_PLANNING_WORKLIST;
  sourceContextHash: string;
  sourceSlots: Array<{ slot: number; contextHash: string }>;
  actionCount: number;
  actions: Array<{ slot: number; action: Record<string, unknown> }>;
  targetChoices: Array<{ targetSelector: string; handle: string; label: string; slots: number[] }>;
}

/** Copy the complete task records; never decide which natural-language facts matter. */
export function buildPhysicalPlanningWorklist(context: unknown): PhysicalPlanningWorklist {
  if (!object(context) || !object(context.task)) return fail("missing physical task");
  if (Object.hasOwn(context.task, "planningWorklist")) return fail("repeated projection");
  const domains = planChoiceDomains(context);
  const contexts = isSharedBatchContext(context.state) ? expandSharedBatchContexts(context.state) : [context];
  const actions: PhysicalPlanningWorklist["actions"] = [], targets = new Map<string, PhysicalPlanningWorklist["targetChoices"][number]>();
  contexts.forEach((entry, slot) => {
    const assigned = (entry.state as { actionSet: { assigned: Record<string, unknown>[] } }).actionSet.assigned;
    for (const action of assigned) actions.push({ slot, action: structuredClone(action) });
    const candidates = (entry.referenceCatalog as { candidates: Record<string, unknown>[] }).candidates;
    for (const candidate of candidates) {
      if (candidate.kind !== "entity" || !(candidate.allowedUses as string[]).includes("target")) continue;
      if (typeof candidate.label !== "string") return fail("missing target source label");
      const choice = { targetSelector: candidate.targetSelector as string, handle: candidate.handle as string, label: candidate.label };
      const key = contentHash(choice), existing = targets.get(key);
      if (existing) { if (!existing.slots.includes(slot)) existing.slots.push(slot); }
      else targets.set(key, { ...choice, slots: [slot] });
    }
  });
  const targetChoices = [...targets.values()];
  if (actions.length !== domains.actionRefs.length || new Set(targetChoices.map(choice => choice.targetSelector)).size !== domains.targetSelectors.length) return fail("projection coverage changed");
  return { contract: PHYSICAL_PLANNING_WORKLIST, sourceContextHash: contentHash(context),
    sourceSlots: contexts.map((entry, slot) => ({ slot, contextHash: contentHash(entry) })),
    actionCount: actions.length, actions, targetChoices };
}

export function withoutPhysicalPlanningWorklist(context: unknown): Record<string, unknown> {
  const copy = structuredClone(context);
  if (!object(copy) || !object(copy.task) || !Object.hasOwn(copy.task, "planningWorklist")) return fail("missing projection");
  delete copy.task.planningWorklist;
  return copy;
}

export function assertPhysicalPlanningWorklist(context: unknown): void {
  const source = withoutPhysicalPlanningWorklist(context);
  const actual = (context as { task: { planningWorklist: unknown } }).task.planningWorklist;
  if (contentHash(actual) !== contentHash(buildPhysicalPlanningWorklist(source))) return fail("source or projection binding changed");
}

export function physicalPlanningWorklistRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(`/${PHYSICAL_PLANNING_WORKLIST}@`)) return fail("repeated codec");
  const worklist = buildPhysicalPlanningWorklist(request.context), original = request.context as Record<string, unknown>;
  const context = { ...structuredClone(original), task: { ...structuredClone(original.task as Record<string, unknown>), planningWorklist: worklist } };
  assertPhysicalPlanningWorklist(context);
  return { ...request, context, userPrompt: [request.userPrompt, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${PHYSICAL_PLANNING_WORKLIST}@${contentHash({ instruction, worklist }).slice(0, 16)}` };
}

/** Below existing physical codecs so the worklist copies their actual visible choices. */
export function physicalPlanningWorklistProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(physicalPlanningWorklistRequest(request)),
  };
}
