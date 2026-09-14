import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { decodeIndexedPlans, sourceIndexedPlanningInstruction, type PlanningIndexDomain } from "../../mechanics/source-indexed-planning";
import { indexedPlanningSourceDomain } from "./target-owned-plans";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`canonical planning targets: ${message}`); };
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: ["plans"], message }]); };
const effects = ["primaryEffect", "secondaryEffect", "threatenedEffect"];
const instruction = loadPromptAsset("shared/canonical-planning-targets.md");
export const CANONICAL_PLANNING_TARGETS = `canonical-planning-targets-v1@${contentHash(instruction).slice(0, 16)}`;
const at = <T>(values: readonly T[], index: unknown): T | undefined =>
  typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? values[index] : undefined;

/** Change explicit target coordinates while retaining every other selected field. */
export class CanonicalPlanningTargetsCodec {
  readonly domain: PlanningIndexDomain;
  private readonly sourceHash: string;
  private readonly domainHash: string;

  constructor(private readonly context: unknown) {
    this.domain = indexedPlanningSourceDomain(context);
    this.sourceHash = contentHash(context);
    this.domainHash = contentHash(this.domain);
  }

  private assertBinding(): void {
    if (contentHash(this.context) !== this.sourceHash || contentHash(this.domain) !== this.domainHash) fail("source or domain changed before decoding");
  }

  decode(raw: unknown): unknown {
    this.assertBinding();
    const value = structuredClone(raw);
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return value;
    value.plans = value.plans.map(plan => {
      if (!object(plan)) return plan;
      const action = at(this.domain.actions, plan.actionIndex);
      if (!action) return plan;
      const issues: string[] = [];
      if (Object.hasOwn(plan, "targetIndices") || !Array.isArray(plan.targetRefs)) issues.push("missing or mixed plan targets");
      const refs: unknown[] = Array.isArray(plan.targetRefs) ? plan.targetRefs : [];
      const indices = refs.map(ref => this.domain.targets.findIndex(target => target.handle === ref && target.slots.includes(action.slot)));
      if (indices.includes(-1)) issues.push("unknown or cross-slot target");
      const copy = { ...plan, targetIndices: indices };
      delete (copy as Value).targetRefs;
      for (const field of effects) {
        const effect = plan[field]; if (!object(effect)) continue;
        const position = refs.indexOf(effect.targetRef);
        if (Object.hasOwn(effect, "targetPosition") || position < 0) issues.push(`missing or mixed ${field} subject`);
        const mapped = { ...effect, targetPosition: position }; delete (mapped as Value).targetRef;
        (copy as Value)[field] = mapped;
      }
      if (issues.length) (copy as Value).invalidCanonicalTargets = { rejectedValue: structuredClone(plan), issues };
      return copy;
    });
    return value;
  }

  /** Repeated positions normalize only when they denote the same canonical entity. */
  encode(raw: unknown): unknown {
    this.assertBinding();
    const value = structuredClone(raw);
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("missing indexed plans");
    for (const plan of value.plans) {
      if (!object(plan) || Object.hasOwn(plan, "targetRefs") || !Array.isArray(plan.targetIndices)) return invalid("invalid indexed targets");
      const action = at(this.domain.actions, plan.actionIndex);
      if (!action) return invalid("unknown actionIndex");
      const refs = plan.targetIndices.map(index => {
        const target = at(this.domain.targets, index);
        if (!target?.slots.includes(action.slot)) return invalid("unknown or cross-slot indexed target");
        return target.handle;
      });
      plan.targetRefs = refs; delete plan.targetIndices;
      for (const field of effects) {
        const effect = plan[field]; if (effect === null) continue;
        if (!object(effect) || Object.hasOwn(effect, "targetRef")) return invalid("invalid indexed effect");
        const ref = at(refs, effect.targetPosition);
        if (!ref) return invalid("effect subject absent from selected targets");
        effect.targetRef = ref; delete effect.targetPosition;
      }
    }
    if (contentHash(decodeIndexedPlans(this.decode(value), this.domain)) !== contentHash(decodeIndexedPlans(raw, this.domain))) return invalid("canonical round trip changed");
    return value;
  }

  schema(input: Value): Value {
    this.assertBinding();
    const schema = structuredClone(input), definition = "canonical_planning_target";
    if (schema.definitions !== undefined && !object(schema.definitions)) return fail("invalid schema definitions");
    const definitions = (schema.definitions ??= {}) as Value;
    if (Object.hasOwn(definitions, definition)) return fail("occupied target definition");
    definitions[definition] = this.domain.targets.length ? { type: "string", enum: this.domain.targets.map(target => target.handle) } : { not: {} };
    const ref = { $ref: `#/definitions/${definition}` }; let plans = 0, effectCount = 0;
    const rename = (node: Value, fields: Value, from: string, to: string, replacement: unknown): void => {
      if (!Array.isArray(node.required) || !node.required.includes(from) || Object.hasOwn(fields, to)) return fail("unexpected target field contract");
      node.properties = Object.fromEntries(Object.entries(fields).map(([key, value]) => key === from ? [to, replacement] : [key, value]));
      node.required = node.required.map(key => key === from ? to : key);
    };
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; } if (!object(node)) return;
      const fields = node.properties;
      if (object(fields) && ["actionIndex", "targetIndices", "means", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
        if (!object(fields.targetIndices) || fields.targetIndices.type !== "array") return fail("invalid plan targets schema");
        rename(node, fields, "targetIndices", "targetRefs", { ...fields.targetIndices, items: ref,
          description: "Exact entity handles from the complete target worklist within this action's source slot; preserve order and repetitions." }); plans++;
      } else if (object(fields) && ["targetPosition", "sourceRefs", "channel", "proposalKey"].every(key => Object.hasOwn(fields, key))) {
        rename(node, fields, "targetPosition", "targetRef", { ...ref, description: "Exact entity handle present in this plan's targetRefs." }); effectCount++;
      }
      Object.values(node).forEach(visit);
    };
    visit(schema);
    if (!plans || !effectCount) return fail("missing indexed plan or effect schema");
    return schema;
  }
}

export function canonicalPlanningTargetsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(CANONICAL_PLANNING_TARGETS)) return fail("already applied");
  if (!request.wireJsonSchema) return fail("missing wire schema");
  const codec = new CanonicalPlanningTargetsCodec(request.context), wireJsonSchema = codec.schema(request.wireJsonSchema);
  const indexed = sourceIndexedPlanningInstruction(true), paragraphs = indexed.split("\n\n");
  if (paragraphs.length !== 3 || !paragraphs[1]?.startsWith("Use plan.targetIndices")) return fail("indexed instruction changed");
  const replacement = [paragraphs[0], instruction, paragraphs[2]].join("\n\n");
  const replace = (text: string | undefined): string => {
    if (text?.split(indexed).length !== 2) return fail("requires one indexed instruction in system and tail");
    return text.replace(indexed, replacement);
  };
  const system = replace(request.system), jsonObjectPostlude = replace(request.jsonObjectPostlude);
  const sourceSchemaHash = contentHash(request.wireJsonSchema), schemaHash = contentHash(wireJsonSchema);
  return { ...request, system, jsonObjectPostlude, wireJsonSchema,
    promptVersion: `${request.promptVersion}/${CANONICAL_PLANNING_TARGETS}@${contentHash({ context: request.context, wireJsonSchema, system, jsonObjectPostlude }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(request.wireJsonSchema) !== sourceSchemaHash || contentHash(wireJsonSchema) !== schemaHash) return fail("schema changed before decoding");
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
