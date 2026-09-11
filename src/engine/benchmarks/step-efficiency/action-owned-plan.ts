import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { FlatTruthBatchCodec } from "./flat-truth-batch";
import { recordedContext } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const sourceKinds = ["action", "entity", "fact", "condition", "rating", "law", "placement"];
const authoredKinds = new Set(["rating", "law"]);
const nonnumeric = new Set(["permission", "secondary", "risk"]);
const roles = new Set([...nonnumeric, "control", "potency", "protection"]);

function factorConstants(value: ObjectValue): ObjectValue {
  if (!object(value.source) || !sourceKinds.includes(String(value.source.kind)) || !roles.has(String(value.role))) throw new Error("factor selector is invalid");
  const constants: ObjectValue = {};
  if (!authoredKinds.has(String(value.source.kind))) constants.authority = "semantic";
  const authority = value.authority ?? constants.authority;
  if (authority !== "semantic" && authority !== "authored") throw new Error("law/rating factor requires an explicit authority choice");
  if (nonnumeric.has(String(value.role))) { constants.direction = "neutral"; constants.steps = 0; }
  else if (value.role === "control" || authority === "semantic") constants.steps = 1;
  return constants;
}

export function encodePlanFactor(value: ObjectValue): ObjectValue {
  const wire = structuredClone(value);
  for (const [key, expected] of Object.entries(factorConstants(value))) {
    if (wire[key] !== expected) throw new Error("canonical factor violates a fixed schema field");
    delete wire[key];
  }
  return wire;
}

export function decodePlanFactor(value: unknown, allowConsistentConstants = false): ObjectValue {
  if (!object(value)) throw new Error("factor must be an object");
  const constants = factorConstants(value);
  const keys = ["source", "authority", "role", "direction", "steps", "channel", "explanation"].filter((key) => !Object.hasOwn(constants, key));
  const present = Object.keys(value).filter((key) => !allowConsistentConstants || !Object.hasOwn(constants, key));
  if (contentHash(present.sort()) !== contentHash(keys.sort())) throw new Error("factor must contain exactly its variable fields");
  for (const [key, expected] of Object.entries(constants)) {
    if (Object.hasOwn(value, key) && value[key] !== expected) throw new Error("factor contradicts a fixed schema field");
  }
  return { ...structuredClone(value), ...constants };
}

function leaves(node: unknown): ObjectValue[] {
  if (!object(node)) throw new Error("closed factor schema required");
  const alternatives = node.oneOf ?? node.anyOf;
  if (Array.isArray(alternatives)) return alternatives.flatMap(leaves);
  if (!object(node.properties) || node.additionalProperties !== false || !Array.isArray(node.required)) throw new Error("closed schema leaf required");
  return [node];
}

/** Factor out only constants implied by fields that remain in the wire schema. */
function factorWireSchema(node: unknown, allowConsistentConstants: boolean): ObjectValue {
  const branches = leaves(node).flatMap((leaf) => {
    const properties = leaf.properties as ObjectValue;
    const sources = leaves(properties.source);
    return [false, true].flatMap((authoredSource) => {
      const selected = sources.filter((source) => {
        const kind = ((source.properties as ObjectValue).kind as ObjectValue).const;
        return authoredKinds.has(String(kind)) === authoredSource;
      });
      if (!selected.length) return [];
      const branch = structuredClone(leaf), fields = branch.properties as ObjectValue;
      fields.source = selected.length === 1 ? selected[0] : { oneOf: selected };
      for (const key of ["authority", "direction", "steps"]) {
        const field = fields[key];
        if (object(field) && Object.hasOwn(field, "const") && (key !== "authority" || !authoredSource)) {
          if (!allowConsistentConstants) delete fields[key];
          branch.required = (branch.required as string[]).filter((item) => item !== key);
        }
      }
      return [branch];
    });
  });
  return { anyOf: branches };
}

/** An action belongs to exactly one original logical slot. The model selects
 * its prebound key and writes all variable plan content; identity and schema
 * constants are mechanically restored. Unknown, duplicate or missing actions
 * never become successful output. */
export class ActionOwnedPlanCodec {
  readonly originalSchema;
  readonly wireSchema: ObjectValue;
  readonly contextHash: string;
  readonly bindings: ReadonlyArray<{ key: string; slot: number; actionRef: string }>;
  readonly count: number;

  constructor(context: ObjectValue, readonly allowConsistentConstants = false) {
    this.contextHash = contentHash(context);
    const contexts = expandSharedBatchContexts(context.state as SharedBatchContext);
    this.count = contexts.length;
    const base = new FlatTruthBatchCodec("plan", this.count);
    this.originalSchema = base.originalSchema;
    this.bindings = contexts.flatMap((value, slot) => z.object({ state: z.object({ actionSet: z.object({
      assigned: z.array(z.object({ actionRef: z.string().min(1) })).min(1),
    }) }) }).parse(value).state.actionSet.assigned.map(({ actionRef }) => ({ slot, actionRef })))
      .map((value, index) => ({ key: `action_${index.toString(36)}`, ...value }));
    if (new Set(this.bindings.map((binding) => binding.actionRef)).size !== this.bindings.length) throw new Error("action ownership is ambiguous across source slots");
    const fields = base.wireSchema.properties as ObjectValue;
    const plans = structuredClone((fields.plans as ObjectValue).items);
    for (const leaf of leaves(plans)) {
      const properties = leaf.properties as ObjectValue;
      for (const key of ["slot", "actionRef"]) {
        if (!Object.hasOwn(properties, key)) throw new Error("plan identity schema drift");
        delete properties[key];leaf.required = (leaf.required as string[]).filter((item) => item !== key);
      }
      const factors = properties.factors;
      if (!object(factors)) throw new Error("plan factors schema missing");
      factors.items = factorWireSchema(factors.items, this.allowConsistentConstants);
    }
    this.wireSchema = { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false,
      properties: { slots: fields.slots, kind: fields.kind, plans: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(this.bindings.map(({ key }) => [key, { $ref: "#/definitions/actionPlan" }])), required: this.bindings.map(({ key }) => key) } },
      required: ["slots", "kind", "plans"], definitions: { actionPlan: plans } };
  }

  encode(value: unknown): ObjectValue {
    const original = this.originalSchema.parse(value);
    const plans: ObjectValue = {};
    for (const { slot, result } of original.slots) {
      if (!("plans" in result)) throw new Error("owned codec requires plans");
      for (const plan of result.plans) {
        const binding = this.bindings.find((entry) => entry.slot === slot && entry.actionRef === plan.actionRef);
        if (!binding || Object.hasOwn(plans, binding.key)) throw new Error("plan ownership or uniqueness mismatch");
        const rest = structuredClone(plan) as unknown as ObjectValue;
        delete rest.actionRef;
        plans[binding.key] = { ...structuredClone(rest), factors: plan.factors.map((factor) => encodePlanFactor(factor as unknown as ObjectValue)) };
      }
    }
    const wire = { slots: original.slots.map(({ slot }) => slot), kind: "commit_plans", plans };
    if (contentHash(this.decode(wire)) !== contentHash(original)) throw new Error("owned plan round trip changed canonical output");
    return wire;
  }

  decode(value: unknown) {
    if (!object(value) || Object.keys(value).sort().join(",") !== "kind,plans,slots" || value.kind !== "commit_plans" || !object(value.plans)) throw new Error("complete owned plan root required");
    const slots = z.array(z.number().int().min(0).max(this.count - 1)).length(this.count).parse(value.slots);
    if (new Set(slots).size !== this.count || contentHash(Object.keys(value.plans).sort()) !== contentHash(this.bindings.map(({ key }) => key).sort())) throw new Error("complete owned action and slot coverage required");
    const grouped = new Map(slots.map((slot) => [slot, [] as ObjectValue[]]));
    for (const [key, plan] of Object.entries(value.plans)) {
      const binding = this.bindings.find((entry) => entry.key === key)!;
      if (!object(plan) || Object.hasOwn(plan, "slot") || Object.hasOwn(plan, "actionRef") || !Array.isArray(plan.factors)) throw new Error("owned plan must supply content without redundant identity");
      grouped.get(binding.slot)!.push({ ...structuredClone(plan), actionRef: binding.actionRef,
        factors: plan.factors.map((factor) => decodePlanFactor(factor, this.allowConsistentConstants)) });
    }
    return this.originalSchema.parse({ slots: slots.map((slot) => ({ slot, result: { kind: "commit_plans", plans: grouped.get(slot) } })) });
  }

  body(source: TemporalProbeBody): TemporalProbeBody {
    if (source.thinking.type !== "disabled") throw new Error("owned plan keeps thinking disabled");
    const body = structuredClone(source), message = body.messages[1]!.content, context = recordedContext(message);
    if (contentHash(context.value) !== this.contextHash) throw new Error("owned plan source snapshot mismatch");
    const parts = message.split("\nJSON Schema: ");
    if (parts.length !== 2) throw new Error("unique source schema required");
    const end = parts[1]!.indexOf("\n");
    if (end < 0 || contentHash(JSON.parse(parts[1]!.slice(0, end))) !== contentHash(this.originalSchema.toJSONSchema({ target: "draft-07" }))) throw new Error("owned plan source schema mismatch");
    const suffix = parts[1]!.slice(end), example = "\nExample JSON output shape: ";
    if (!suffix.startsWith(example) || suffix.indexOf("\n", 1) < 0) throw new Error("source example boundary mismatch");
    const instruction = "Resolve every numbered slot independently and return exactly one {slot,result} entry per slot in the supplied output schema.";
    if (parts[0]!.split(instruction).length !== 2) throw new Error("source slot instruction mismatch");
    const notice = "Return one plans object with exactly the keys in the source-bound Plan ownership index. Each key denotes one original assigned action and its original slot context; generate that action's full plan once. Do not output slot or actionRef inside a plan: the key restores them exactly. Keep the complete slots order and root kind=commit_plans. All other original plan fields and meanings remain required. For each factor keep source, role, channel and explanation. Only law/rating sources need explicit authority (semantic or authored); other source kinds inherently have semantic authority. permission/secondary/risk inherently mean neutral direction and zero steps: omit direction and steps. control inherently has one step: omit steps but keep direction. Semantic potency/protection inherently has one step: omit steps; authored potency/protection keeps its explicit one-or-two steps. All variable fields remain explicit. These are reversible schema constants, not permission to drop causes, effects, actions or references. Other slots' reference scopes remain unavailable.";
    const constantPolicy = this.allowConsistentConstants
      ? " Schema-fixed factor fields may also be explicitly repeated with exactly their required values; omission is preferred for compactness. Consistent redundant constants and omitted constants encode the same value. Contradictory constants are invalid and never corrected."
      : "";
    body.messages[1]!.content = `${parts[0]!.replace(instruction, notice + constantPolicy)}\nPlan ownership index (source data, complete required keys): ${JSON.stringify(this.bindings)}\nJSON Schema: ${JSON.stringify(this.wireSchema)}\nExample JSON output shape: ${JSON.stringify({ slots: Array.from({ length: this.count }, (_, slot) => slot), kind: "commit_plans", plans: {} })}\nThe empty plans map illustrates the container only and is invalid as an answer: every ownership key requires its full original plan.${suffix.slice(suffix.indexOf("\n", 1))}`;
    if (contentHash(recordedContext(body.messages[1]!.content).value) !== this.contextHash) throw new Error("owned codec changed source context");
    return body;
  }
}
