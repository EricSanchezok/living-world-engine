import { z } from "zod";
import type { AgentActionProposal } from "../../contracts/model";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor } from "../../contracts/model-context";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

export class SourceActionDescriptionMismatch extends Error {}

/** Source-owned text is bound by action identity and current slot, including repairs. */
export class SourceActionDescription {
  private readonly bySlot = new Map<number, string>();

  constructor(context: unknown, actions: readonly AgentActionProposal[]) {
    const sources = new Map(actions.map((action) => [String(actionCompilationCandidateKeyForHandle(referenceHandleFor("action", action.id))), action]));
    if (sources.size !== actions.length) throw new Error("duplicate source action identity");
    const slots = record(record(context)?.task)?.slots;
    if (!Array.isArray(slots) || !slots.length) throw new Error("source description requires actual request slots");
    const seen = new Set<string>();
    for (const value of slots) {
      const slot = record(value);
      const key = record(slot?.actionReferences)?.actionCandidateKey;
      const action = typeof key === "string" ? sources.get(key) : undefined;
      if (!action || typeof slot?.slot !== "number" || !Number.isInteger(slot.slot) || slot.slot < 0 ||
        this.bySlot.has(slot.slot) || seen.has(action.id)) throw new Error("source description lost request action binding");
      seen.add(action.id);
      this.bySlot.set(slot.slot, action.rawText);
    }
  }

  wireSchema(schema: z.ZodType, omitField = false): z.ZodType {
    const json = z.toJSONSchema(schema, { target: "draft-07" }) as RecordValue;
    const slots = record(record(json.properties)?.slots);
    const plan = record(record(record(slots?.items)?.properties)?.temporalPlan);
    if (!plan) throw new Error("source description requires a temporal plan schema");
    const visit = (branch: RecordValue): void => {
      if (record(branch.properties)?.description) {
        if (!Array.isArray(branch.required)) throw new Error("missing temporal plan required fields");
        branch.required = branch.required.filter((key) => key !== "description");
        if (omitField) delete (branch.properties as RecordValue).description;
      } else if (Array.isArray(branch.oneOf)) branch.oneOf.forEach((child) => visit(child as RecordValue));
      else throw new Error("unsupported temporal plan schema");
    };
    visit(plan);
    return z.fromJSONSchema(json);
  }

  private map(value: unknown, transform: (plan: RecordValue, source: string) => RecordValue): unknown {
    const object = record(value);
    if (!Array.isArray(object?.slots)) return structuredClone(value);
    return { ...object, slots: object.slots.map((value) => {
      const slot = record(value);
      const plan = record(slot?.temporalPlan);
      const source = typeof slot?.slot === "number" ? this.bySlot.get(slot.slot) : undefined;
      return plan && source !== undefined ? { ...slot, temporalPlan: transform(plan, source) } : structuredClone(value);
    }) };
  }

  restore(value: unknown): unknown {
    return this.map(value, (plan, source) => Object.hasOwn(plan, "description") ? plan : { ...plan, description: source });
  }

  omit(value: unknown): unknown {
    return this.map(value, (plan, source) => {
      if (plan.description !== source) return plan;
      const result = { ...plan };
      delete result.description;
      return result;
    });
  }

  assertConsistent(value: unknown): void {
    this.map(value, (plan, source) => {
      if (Object.hasOwn(plan, "description") && plan.description !== source) {
        throw new SourceActionDescriptionMismatch("temporalPlan.description must be omitted or equal the exact original action text; paraphrasing or adding work is forbidden");
      }
      return plan;
    });
  }
}
