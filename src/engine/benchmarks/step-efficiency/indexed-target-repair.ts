import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { SOURCE_INDEXED_PLANNING } from "../../mechanics/source-indexed-planning";
import { planningSourceContexts } from "./planning-source-contexts";
import { decodeLogicalPlanSelectors } from "../../mechanics/plan-source-selectors";
import { decodeResolutionFactorTypes } from "../../mechanics/resolution-factor-types";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`indexed target repair: ${message}`); };
const record = (value: unknown): Value => object(value) ? value : fail("missing source record");
const rows = (value: unknown): Value[] => Array.isArray(value) && value.every(object) ? value : fail("missing source rows");
const instruction = loadPromptAsset("shared/indexed-target-repair.md");
export const INDEXED_TARGET_REPAIR = `indexed-target-repair-v1@${contentHash(instruction).slice(0, 16)}`;
const effects = ["primaryEffect", "secondaryEffect", "threatenedEffect"];

/** Map stable rejected action identities to current generated fields; never select targets. */
export function indexedTargetRepairDiagnostics(context: unknown) {
  const source = record(context), task = record(source.task), indices = record(task.planningIndices);
  if (indices.contract !== SOURCE_INDEXED_PLANNING) return fail("unsupported indexed contract");
  const worklist = record(task.planningWorklist), actions = rows(worklist.actions);
  if (indices.actionCount !== actions.length || worklist.actionCount !== actions.length ||
    actions.some((row, index) => row.actionIndex !== index)) return fail("incomplete action indices");
  const contexts = planningSourceContexts(source);
  const assignments = new Map<string, { actionIndex: number; slot: number }>();
  for (const row of actions) {
    const action = record(row.action), slot = row.slot;
    if (typeof action.actionRef !== "string" || assignments.has(action.actionRef) ||
      !Number.isSafeInteger(slot) || (slot as number) < 0 || !contexts[slot as number]) return fail("ambiguous action assignment");
    const assigned = rows(record(record(contexts[slot as number]!.state).actionSet).assigned)
      .filter(entry => entry.actionRef === action.actionRef);
    if (assigned.length !== 1 || ["actorRef", "rawText", "goal", "means"].some(field =>
      contentHash(assigned[0]![field]) !== contentHash(action[field]))) return fail("changed source action");
    assignments.set(action.actionRef, { actionIndex: row.actionIndex as number, slot: slot as number });
  }
  const diagnostics: Array<{ actionIndex: number; sourceSlot: number; actionRef: string; previousPlanIndex: number;
    previousTargetRefs: unknown[]; failedEffects: Array<{ field: string; canonicalPath: unknown[]; decodedTarget: string; rejectedTargetPosition: unknown }> }> = [];
  contexts.forEach((logical, slot) => {
    if (logical.repair === null || logical.repair === undefined) return;
    const repair = record(logical.repair);
    if (!Array.isArray(repair.issues)) return fail("missing repair issues");
    const relevant = repair.issues.filter(issue => object(issue) && Array.isArray(issue.path) &&
      issue.path.length === 4 && issue.path[0] === "plans" && effects.includes(String(issue.path[2])) &&
      issue.path[3] === "targetRef" && typeof issue.originalValue === "string" && issue.originalValue.startsWith("unresolved-index:"));
    if (!relevant.length) return;
    const previous = record(repair.previousOutput), binding = record(repair.candidateBinding);
    const canonicalPrevious = decodeResolutionFactorTypes(decodeLogicalPlanSelectors(previous, logical));
    if (repair.previousOutputAvailable !== true || binding.canonicalOutputHash !== contentHash(canonicalPrevious) ||
      previous.kind !== "commit_plans") return fail("rejected candidate binding changed");
    const plans = rows(previous.plans), grouped = new Map<number, typeof diagnostics[number]>();
    for (const issue of relevant) {
      const path = issue.path as unknown[], planIndex = path[1], field = String(path[2]);
      if (!Number.isSafeInteger(planIndex) || (planIndex as number) < 0 || !plans[planIndex as number]) return fail("invalid diagnostic plan index");
      const plan = plans[planIndex as number]!, actionRef = plan.actionRef;
      const assignment = typeof actionRef === "string" ? assignments.get(actionRef) : undefined;
      if (!assignment || assignment.slot !== slot || !Array.isArray(plan.targetRefs)) return fail("repair action is outside its source slot");
      if (record(plan[field]).targetRef !== issue.originalValue) return fail("diagnostic value differs from rejected effect");
      let position: unknown;
      try { position = JSON.parse((issue.originalValue as string).slice("unresolved-index:".length)); }
      catch { return fail("uninterpretable rejected position"); }
      const entry: typeof diagnostics[number] = grouped.get(planIndex as number) ?? { actionIndex: assignment.actionIndex, sourceSlot: slot,
        actionRef: actionRef as string, previousPlanIndex: planIndex as number, previousTargetRefs: structuredClone(plan.targetRefs), failedEffects: [] };
      entry.failedEffects.push({ field, canonicalPath: structuredClone(path), decodedTarget: issue.originalValue as string, rejectedTargetPosition: position });
      grouped.set(planIndex as number, entry);
    }
    diagnostics.push(...grouped.values());
  });
  return { contract: INDEXED_TARGET_REPAIR, sourceContextHash: contentHash(source), diagnostics };
}

export function indexedTargetRepairRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(INDEXED_TARGET_REPAIR)) return fail("already applied");
  const source = record(request.context), task = record(source.task);
  if (Object.hasOwn(task, "indexedTargetRepair")) return fail("diagnostic field already exists");
  const diagnostics = indexedTargetRepairDiagnostics(source);
  if (!diagnostics.diagnostics.length) return request;
  let plans = 0, targets = 0;
  const verifyFields = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(verifyFields); return; }
    if (!object(value)) return;
    const fields = value.properties;
    if (object(fields) && ["actionIndex", "mode", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
      if (!object(fields.targetIndices) || fields.targetIndices.type !== "array" || Object.hasOwn(fields, "targetRefs")) return fail("incompatible generated target list");
      plans++;
    }
    if (object(fields) && ["sourceRefs", "channel", "proposalKey"].every(key => Object.hasOwn(fields, key))) {
      if (!object(fields.targetPosition) || fields.targetPosition.type !== "integer" || Object.hasOwn(fields, "targetRef")) return fail("incompatible generated effect target");
      targets++;
    }
    Object.values(value).forEach(verifyFields);
  };
  verifyFields(request.wireJsonSchema);
  if (!plans || !targets) return fail("missing generated target relationship");
  const context = { ...structuredClone(source), task: { ...structuredClone(task), indexedTargetRepair: diagnostics } };
  const sourceHash = contentHash(source), contextHash = contentHash(context);
  return { ...request, context, userPrompt: request.userPrompt + "\n\n" + instruction,
    promptVersion: `${request.promptVersion}/${INDEXED_TARGET_REPAIR}@${contentHash(diagnostics).slice(0, 16)}`,
    preprocessOutput: value => {
      if (contentHash(source) !== sourceHash || contentHash(context) !== contextHash) return fail("source or diagnostics changed before decoding");
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
