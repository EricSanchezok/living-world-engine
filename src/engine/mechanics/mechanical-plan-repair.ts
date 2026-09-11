import type { z } from "zod";
import type { resolutionDirectiveSchema, ResolutionPlanDraft } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";
import type { SemanticRepairContext } from "../models/semantic-repair";
import { LOGICAL_CANDIDATE_REPAIR_NOTICE } from "../prompts/logical-repair-context";

type Directive = z.infer<typeof resolutionDirectiveSchema>;
export const MECHANICAL_PLAN_REPAIR_NOTICE = "repair.previousOutput is the complete rejected logical candidate, not committed evidence. Issue paths index that original candidate. Generate exactly one replacement plan for each currently assigned action and no other plans. The engine retains unselected drafts unchanged, restores the original order, and revalidates the complete joint candidate before review or commitment. Use the full original action and world evidence; do not change mode, invent effects, omit supported meaning, or treat an unfinished action as complete merely to satisfy validation.";
export const MECHANICAL_PLAN_REPAIR = `mechanical-plan-replacement-v1@${contentHash(MECHANICAL_PLAN_REPAIR_NOTICE).slice(0, 16)}`;

/** Select only an unambiguous subset of a complete, typed rejected candidate.
 * Selection grants no validity to retained drafts: the caller validates the
 * reconstructed full candidate with its original action and reference scope. */
export function selectMechanicalPlanRepair(input: {
  repair: SemanticRepairContext;
  schema: z.ZodType<Directive>;
  actionIds: readonly string[];
  actionIdFor: (draft: ResolutionPlanDraft) => string;
  sourceHash: () => string;
  expectedSourceHash: string;
}) {
  if (input.repair.attempt === 0 || input.repair.issues.length === 0) return undefined;
  if (input.sourceHash() !== input.expectedSourceHash) throw new ModelConfigurationError("mechanical plan repair source snapshot changed");
  const parsed = input.schema.safeParse(input.repair.previousOutput);
  if (!parsed.success || parsed.data.kind !== "commit_plans" || parsed.data.plans.length !== input.actionIds.length) return undefined;
  const original = structuredClone(parsed.data);
  let actionIds: string[];
  try { actionIds = original.plans.map(input.actionIdFor); } catch { return undefined; }
  if (new Set(actionIds).size !== input.actionIds.length || new Set(original.plans.map(plan => plan.proposalKey)).size !== original.plans.length ||
    input.actionIds.some(id => !actionIds.includes(id))) return undefined;
  const indices = new Set<number>();
  for (const issue of input.repair.issues) {
    const [field, index] = issue.path;
    if (field !== "plans" || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= original.plans.length) return undefined;
    indices.add(index);
  }
  const owners = new Map<string, Set<number>>();
  const references: Array<{ key: string; ordinal: number }> = [];
  const visit = (node: unknown, ordinal: number): void => {
    if (Array.isArray(node)) { node.forEach(value => visit(value, ordinal)); return; }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.proposalKey === "string") {
      if (Object.keys(record).length === 1) references.push({ key: record.proposalKey, ordinal });
      else {
        const declarations = owners.get(record.proposalKey) ?? new Set<number>();
        declarations.add(ordinal); owners.set(record.proposalKey, declarations);
      }
    }
    Object.values(record).forEach(value => visit(value, ordinal));
  };
  original.plans.forEach(visit);
  // Include both declaration owners and dependents; a local candidate must not
  // depend on an absent output declaration during provider normalization.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const reference of references) {
      const connected = [reference.ordinal, ...(owners.get(reference.key) ?? [])];
      if (!connected.some(ordinal => indices.has(ordinal))) continue;
      for (const ordinal of connected) if (!indices.has(ordinal)) { indices.add(ordinal); expanded = true; }
    }
  }
  if (indices.size === 0 || indices.size === original.plans.length) return undefined;
  const selectedActionIds = actionIds.filter((_id, index) => indices.has(index));
  const selected = new Set(selectedActionIds);
  const sourceHash = input.sourceHash();
  const binding = { contractVersion: MECHANICAL_PLAN_REPAIR, sourceHash, previousOutputHash: contentHash(original),
    replacementActionRefs: original.plans.filter((_plan, index) => indices.has(index)).map(plan => plan.actionRef),
    originalOrdinals: [...indices].sort((a, b) => a - b), retainedPlanCount: original.plans.length - indices.size };
  return {
    selectedActionIds, binding,
    merge(replacement: Directive): Directive {
      if (input.sourceHash() !== sourceHash) throw new ModelConfigurationError("mechanical plan repair source snapshot changed");
      if (replacement.kind !== "commit_plans" || replacement.plans.length !== selected.size) throw new Error("mechanical plan repair must cover exactly its assigned actions");
      const replacements = new Map<string, ResolutionPlanDraft>();
      for (const draft of replacement.plans) {
        const id = input.actionIdFor(draft);
        if (!selected.has(id) || replacements.has(id)) throw new Error("mechanical plan repair changed or repeated its assigned action identity");
        replacements.set(id, structuredClone(draft));
      }
      return { ...structuredClone(original), plans: original.plans.map((plan, index) => replacements.get(actionIds[index]!) ?? structuredClone(plan)) };
    },
  };
}

/** Keep full rejected evidence while making replacement responsibility explicit. */
export function bindMechanicalPlanRepairContext(context: unknown, binding: NonNullable<ReturnType<typeof selectMechanicalPlanRepair>>["binding"], scopedContext: unknown) {
  const value = context as { task?: { constraints?: unknown[] }; repair?: Record<string, unknown> };
  const scoped = scopedContext as { task?: { constraints?: unknown[] } };
  if (!value.task || !Array.isArray(value.task.constraints) || !value.repair || !scoped.task || !Array.isArray(scoped.task.constraints)) throw new ModelConfigurationError("mechanical plan repair requires its bound logical repair envelope");
  return { ...scoped, task: { ...scoped.task, constraints: [...scoped.task.constraints.filter(item => item !== LOGICAL_CANDIDATE_REPAIR_NOTICE), MECHANICAL_PLAN_REPAIR_NOTICE] },
    repair: { ...value.repair, planReplacement: structuredClone(binding) } };
}
