import { z } from "zod";
import { PLAN_CAUSE_SCOPE } from "../contracts/prompts";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { assertIndexedPlanningContext, planningIndexDomain, withoutPlanningIndices } from "./source-indexed-planning";
import { withoutPhysicalPlanningWorklist } from "./physical-planning-worklist";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

const instruction = "For each plan, emit causeIndices instead of causes. Select indices from task.planCauseChoices.choices; each row binds an exact existing kind/ref and its permitted source slots. Select only rows permitted for this actionIndex's original slot and component planCauseScope. Visible actions outside that component cannot be selected as plan causes. Include the row for this plan's own action as required by the canonical plan contract. Preserve every additional supported cause and its order. The decoder restores exactly those pairs; it never supplies a missing action cause. Entities and post-plan evidence have no legal plan-cause index; they may still support other fields under their original contracts. Original state, action intent, means, targets and causal validators remain authoritative. In repair, select indices from the CURRENT domain; a rejected request's indices are only interpretable using its recorded domain. Never emit both causes and causeIndices.";
export const SOURCE_INDEXED_PLAN_CAUSES = `source-indexed-plan-causes-v2@${contentHash(instruction).slice(0, 16)}`;
export const sourceIndexedPlanCausesInstruction = (): string => instruction;
type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`plan cause choices: ${message}`); };
const at = <T>(rows: readonly T[], index: unknown): T | undefined =>
  typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? rows[index] : undefined;
interface Choice { kind: string; ref: string; label: string; slots: number[] }

/** Select evidence explicitly; reconstruct reference spelling only. See decision 0149. */
export class SourceIndexedPlanCauseCodec {
  readonly choices: Choice[] = [];
  readonly actions: ReturnType<typeof planningIndexDomain>["actions"];

  constructor(readonly sourceContext: unknown) {
    assertIndexedPlanningContext(sourceContext);
    const unindexed = withoutPlanningIndices(sourceContext);
    this.actions = planningIndexDomain(unindexed).actions;
    const source = withoutPhysicalPlanningWorklist(unindexed);
    const contexts = isSharedBatchContext(source.state) ? expandSharedBatchContexts(source.state) : [source];
    contexts.forEach((context, slot) => {
      const catalog = object(context.referenceCatalog) && context.referenceCatalog.candidates;
      if (!Array.isArray(catalog)) return fail("missing complete catalog");
      const scope = object(context.task) && context.task.planCauseScope;
      if (!object(scope) || scope.contract !== PLAN_CAUSE_SCOPE || !Array.isArray(scope.actionRefs) ||
        scope.actionRefs.some(ref => typeof ref !== "string") || new Set(scope.actionRefs).size !== scope.actionRefs.length) return fail("missing or invalid component scope");
      const actionRefs = new Set(scope.actionRefs);
      for (const ref of actionRefs) if (!catalog.some(row => object(row) && row.kind === "action" && row.handle === ref &&
        Array.isArray(row.allowedUses) && row.allowedUses.includes("cause"))) return fail("component action absent from cause catalog");
      for (const row of catalog) {
        if (!object(row) || !Array.isArray(row.allowedUses)) return fail("invalid catalog entry");
        if (!row.allowedUses.includes("cause") || !["action", "event", "fact", "law"].includes(row.kind as string)) continue;
        if (typeof row.kind !== "string" || typeof row.handle !== "string" || !row.handle.startsWith(`ref:${row.kind}:`) || typeof row.label !== "string") return fail("invalid cause binding");
        if (row.kind === "action" && !actionRefs.has(row.handle)) continue;
        const existing = this.choices.find(choice => choice.kind === row.kind && choice.ref === row.handle && choice.label === row.label);
        if (existing) { if (!existing.slots.includes(slot)) existing.slots.push(slot); }
        else this.choices.push({ kind: row.kind, ref: row.handle, label: row.label, slots: [slot] });
      }
    });
    for (const action of this.actions) if (!this.choices.some(choice => choice.kind === "action" && choice.ref === action.handle && choice.slots.includes(action.slot))) fail("assigned action has no legal cause binding");
  }

  project(): Value {
    const context = structuredClone(this.sourceContext) as Value, task = context.task as Value;
    if (Object.hasOwn(task, "planCauseChoices")) return fail("repeated source projection");
    task.planCauseChoices = { contract: SOURCE_INDEXED_PLAN_CAUSES, sourceContextHash: contentHash(this.sourceContext),
      choices: this.choices.map((choice, causeIndex) => ({ causeIndex, ...structuredClone(choice) })) };
    return context;
  }

  schema(input: Value): Value {
    const schema = structuredClone(input); let changed = 0;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; } if (!object(node)) return;
      const fields = node.properties;
      if (object(fields) && ["actionIndex", "mode", "means", "causes", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
        if (!object(fields.causes) || fields.causes.type !== "array" || fields.causes.minItems !== 1 || !Array.isArray(node.required) || !node.required.includes("causes") || Object.hasOwn(fields, "causeIndices")) return fail("unexpected plan cause schema");
        fields.causeIndices = { ...fields.causes, description: "Select explicit causeIndex values from the current planCauseChoices domain within this action's source slot.", items: { type: "integer", minimum: 0, maximum: this.choices.length - 1 } };
        delete fields.causes; node.required = node.required.map(key => key === "causes" ? "causeIndices" : key); changed++;
      }
      Object.values(node).forEach(visit);
    };
    visit(schema); if (!changed) return fail("missing indexed plans");
    return schema;
  }

  decode(raw: unknown): unknown {
    const value = structuredClone(raw);
    if (!object(value) || !Array.isArray(value.plans)) return value;
    value.plans = value.plans.map(plan => {
      if (!object(plan)) return plan;
      const action = at(this.actions, plan.actionIndex);
      if (!action || Object.hasOwn(plan, "causes") || !Array.isArray(plan.causeIndices)) return { ...plan,
        invalidCauseSelection: { reason: "require only explicit causeIndices", rejectedDomain: this.choices } };
      const copy = { ...plan }; delete copy.causeIndices;
      let invalid = false;
      copy.causes = plan.causeIndices.map(index => {
        const choice = at(this.choices, index);
        if (choice?.slots.includes(action.slot)) return { kind: choice.kind, ref: choice.ref };
        invalid = true;
        return { kind: "invalid_cause_selection", ref: choice?.ref ?? `unresolved-index:${JSON.stringify(index)}` };
      });
      if (invalid) copy.invalidCauseSelection = { rejectedIndices: plan.causeIndices, rejectedDomain: this.choices };
      return copy;
    });
    return value;
  }

  encode(raw: unknown): unknown {
    const value = structuredClone(raw);
    if (!object(value) || !Array.isArray(value.plans)) return fail("missing source plans");
    for (const plan of value.plans) {
      if (!object(plan) || !Array.isArray(plan.causes) || Object.hasOwn(plan, "causeIndices")) return fail("invalid source causes");
      const action = at(this.actions, plan.actionIndex); if (!action) return fail("invalid action owner");
      plan.causeIndices = plan.causes.map(cause => this.choices.findIndex(choice => object(cause) && choice.kind === cause.kind && choice.ref === cause.ref && choice.slots.includes(action.slot)));
      delete plan.causes;
    }
    if (contentHash(this.decode(value)) !== contentHash(raw)) return fail("source cannot round trip");
    return value;
  }
}

export function sourceIndexedPlanCausesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (!request.wireJsonSchema || request.promptVersion.includes(SOURCE_INDEXED_PLAN_CAUSES)) return fail("requires one indexed planning schema");
  const codec = new SourceIndexedPlanCauseCodec(request.context), wire = codec.schema(request.wireJsonSchema), context = codec.project();
  return { ...request, context, wireJsonSchema: wire, userPrompt: request.userPrompt + "\n\n" + instruction,
    promptVersion: `${request.promptVersion}/${SOURCE_INDEXED_PLAN_CAUSES}@${contentHash({ context, wire }).slice(0, 16)}`,
    preprocessOutput: raw => {
      try { const value = codec.decode(raw); return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] }; }
      catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        throw new z.ZodError(error.issues.map(issue => ({ ...issue, message: `${issue.message}. Rejected request causeIndices domain: ${JSON.stringify(codec.choices)}. Use the CURRENT request domain for repair.` })));
      }
    } };
}
