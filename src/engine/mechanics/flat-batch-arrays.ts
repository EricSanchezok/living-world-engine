import { z } from "zod";
import { contentHash } from "../models/model-audit";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Each required array becomes one batch column. Every item carries its slot;
 * empty per-slot arrays are represented by the absence of rows in that explicit
 * column. No assertion, effect, reference, status or prose is synthesized. */
type BatchValue = { slots: Array<{ slot: number; result: unknown }> };
export class FlatBatchArrayCodec<Output extends BatchValue = BatchValue> {
  readonly wireSchema: ObjectValue;
  protected readonly columns: string[] = [];
  protected readonly constants: ObjectValue = {};

  constructor(readonly originalSchema: z.ZodType<Output>, readonly count: number) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("flat batch requires a positive slot count");
    const original = z.toJSONSchema(this.originalSchema, { target: "draft-07" }) as ObjectValue;
    const properties = original.properties as ObjectValue;
    const result = (((properties.slots as ObjectValue).items as ObjectValue).properties as ObjectValue).result as ObjectValue;
    const slot = { type: "integer", minimum: 0, maximum: count - 1 };
    const withSlot = (value: unknown): ObjectValue => {
      if (!object(value)) throw new Error("flat batch requires typed item schemas");
      const node = structuredClone(value);
      const alternatives = node.oneOf ?? node.anyOf;
      if (Array.isArray(alternatives)) {
        node[node.oneOf ? "oneOf" : "anyOf"] = alternatives.map(withSlot);return node;
      }
      if (node.type !== "object" || node.additionalProperties !== false || !object(node.properties) || !Array.isArray(node.required) || Object.hasOwn(node.properties, "slot")) throw new Error("flat batch requires closed object rows without a slot field");
      node.properties = { slot, ...node.properties };node.required = ["slot", ...node.required];return node;
    };
    const fields: ObjectValue = { slots: { type: "array", minItems: count, maxItems: count, uniqueItems: true, items: slot } };
    for (const [key, value] of Object.entries(result.properties as ObjectValue)) {
      if (!object(value) || key === "slots") throw new Error("unsupported flat batch result field");
      if (value.type === "array") {
        this.columns.push(key);
        fields[key] = { ...structuredClone(value), items: withSlot(value.items),
          ...(typeof value.minItems === "number" ? { minItems: value.minItems * count } : {}),
          ...(typeof value.maxItems === "number" ? { maxItems: value.maxItems * count } : {}) };
      } else if (Object.hasOwn(value, "const")) {
        this.constants[key] = structuredClone(value.const);fields[key] = structuredClone(value);
      } else throw new Error("flat batch only supports arrays and fixed schema discriminators");
    }
    this.wireSchema = { ...original, properties: fields, required: Object.keys(fields) };
  }

  private slots(value: unknown): number[] {
    const slots = z.array(z.number().int().min(0).max(this.count - 1)).length(this.count).parse(value);
    if (new Set(slots).size !== this.count) throw new Error("flat batch slot coverage mismatch");
    return slots;
  }

  encode(value: unknown): ObjectValue {
    const parsed = this.originalSchema.parse(value);
    const slots = this.slots(parsed.slots.map((entry) => entry.slot));
    const wire: ObjectValue = { slots, ...structuredClone(this.constants) };
    for (const column of this.columns) wire[column] = parsed.slots.flatMap(({ slot, result }) =>
      ((result as ObjectValue)[column] as ObjectValue[]).map((row) => ({ slot, ...structuredClone(row) })));
    if (contentHash(this.decode(wire)) !== contentHash(parsed)) throw new Error("flat batch round trip changed validated output");
    return wire;
  }

  regroup(value: unknown) {
    if (!object(value) || contentHash(Object.keys(value).sort()) !== contentHash(["slots", ...this.columns, ...Object.keys(this.constants)].sort())) throw new Error("flat batch requires every explicit column and no extra root fields");
    const slots = this.slots(value.slots);
    for (const [key, expected] of Object.entries(this.constants)) if (contentHash(value[key]) !== contentHash(expected)) throw new Error("flat batch discriminator mismatch");
    const results = new Map(slots.map((slot) => [slot, { ...structuredClone(this.constants), ...Object.fromEntries(this.columns.map((column) => [column, []])) } as ObjectValue]));
    for (const column of this.columns) {
      if (!Array.isArray(value[column])) throw new Error("flat batch column must be an explicit array");
      for (const row of value[column]) {
        if (!object(row) || !Number.isSafeInteger(row.slot) || !results.has(row.slot as number)) throw new Error("flat batch row has an invalid slot");
        const { slot, ...item } = row;
        (results.get(slot as number)![column] as ObjectValue[]).push(structuredClone(item));
      }
    }
    return { slots: slots.map((slot) => ({ slot, result: results.get(slot)! })) };
  }

  decode(value: unknown): Output {
    return this.originalSchema.parse(this.regroup(value));
  }
}
