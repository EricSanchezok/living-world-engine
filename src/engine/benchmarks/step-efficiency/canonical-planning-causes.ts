import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { sourceIndexedPlanCausesInstruction } from "../../mechanics/source-indexed-plan-causes";
import { planningContractTailCauseInstruction } from "../../mechanics/planning-contract-tail";
import { indexedPlanningSourceDomain } from "./target-owned-plans";
import { CANONICAL_PLANNING_TARGETS } from "./canonical-planning-targets";

type Value = Record<string, unknown>;
interface CauseChoice { kind: string; ref: string; slots: number[] }
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`canonical planning causes: ${message}`); };
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: ["plans"], message }]); };
const at = <T>(values: readonly T[], index: unknown): T | undefined =>
  typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? values[index] : undefined;
const instruction = loadPromptAsset("shared/canonical-planning-causes.md");
export const CANONICAL_PLANNING_CAUSES = `canonical-planning-causes-v1@${contentHash(instruction).slice(0, 16)}`;

/** Restore explicit cause bindings only; original selection and semantic validators remain authoritative. */
export class CanonicalPlanningCausesCodec {
  readonly domain: ReturnType<typeof indexedPlanningSourceDomain>;
  readonly choices: CauseChoice[];
  private readonly sourceHash: string;
  private readonly domainHash: string;

  constructor(private readonly context: unknown) {
    this.domain = indexedPlanningSourceDomain(context);
    // The shared source guard verifies this complete projection against its original catalog.
    this.choices = structuredClone((context as { task: { planCauseChoices: { choices: CauseChoice[] } } }).task.planCauseChoices.choices);
    this.sourceHash = contentHash(context);
    this.domainHash = contentHash({ actions: this.domain, choices: this.choices });
  }

  private assertBinding(): void {
    if (contentHash(this.context) !== this.sourceHash || contentHash({ actions: this.domain, choices: this.choices }) !== this.domainHash) fail("source or domain changed before decoding");
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
      if (Object.hasOwn(plan, "causeIndices") || Object.hasOwn(plan, "causes") || !Array.isArray(plan.causeRefs)) issues.push("missing or mixed cause references");
      const refs: unknown[] = Array.isArray(plan.causeRefs) ? plan.causeRefs : [];
      const indices = refs.map(ref => this.choices.findIndex(choice => choice.ref === ref && choice.slots.includes(action.slot)));
      if (indices.includes(-1)) issues.push("unknown or cross-slot cause reference");
      const copy: Value = { ...plan, causeIndices: indices }; delete copy.causeRefs;
      if (issues.length) copy.invalidCanonicalCauses = { rejectedValue: structuredClone(plan), issues };
      return copy;
    });
    return value;
  }

  encode(raw: unknown): unknown {
    this.assertBinding();
    const value = structuredClone(raw);
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("missing indexed plans");
    for (const plan of value.plans) {
      if (!object(plan) || Object.hasOwn(plan, "causeRefs") || Object.hasOwn(plan, "causes") || !Array.isArray(plan.causeIndices)) return invalid("invalid indexed causes");
      const action = at(this.domain.actions, plan.actionIndex); if (!action) return invalid("unknown actionIndex");
      plan.causeRefs = plan.causeIndices.map(index => {
        const choice = at(this.choices, index);
        if (!choice?.slots.includes(action.slot)) return invalid("unknown or cross-slot cause index");
        return choice.ref;
      });
      delete plan.causeIndices;
    }
    return value;
  }

  schema(input: Value): Value {
    this.assertBinding();
    const schema = structuredClone(input), definition = "canonical_planning_cause";
    if (schema.definitions !== undefined && !object(schema.definitions)) return fail("invalid schema definitions");
    const definitions = (schema.definitions ??= {}) as Value;
    if (Object.hasOwn(definitions, definition)) return fail("occupied cause definition");
    definitions[definition] = this.choices.length ? { type: "string", enum: [...new Set(this.choices.map(choice => choice.ref))] } : { not: {} };
    let plans = 0;
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; } if (!object(node)) return;
      const fields = node.properties;
      if (object(fields) && ["actionIndex", "causeIndices", "means", "primaryEffect"].every(key => Object.hasOwn(fields, key))) {
        if (!object(fields.causeIndices) || fields.causeIndices.type !== "array" || !Array.isArray(node.required) ||
          !node.required.includes("causeIndices") || Object.hasOwn(fields, "causeRefs") || Object.hasOwn(fields, "causes")) return fail("unexpected cause field contract");
        node.properties = Object.fromEntries(Object.entries(fields).map(([key, value]) => key === "causeIndices" ? ["causeRefs", {
          ...fields.causeIndices as Value, items: { $ref: `#/definitions/${definition}` },
          description: "Exact cause references from the complete current planCauseChoices table within this action's original slot; preserve order and repetitions.",
        }] : [key, value]));
        node.required = node.required.map(key => key === "causeIndices" ? "causeRefs" : key); plans++;
      }
      Object.values(node).forEach(visit);
    };
    visit(schema); if (!plans) return fail("missing indexed cause schema");
    return schema;
  }
}

const requestHash = (request: StructuredModelRequest<unknown>): string => contentHash({ context: request.context, schema: request.wireJsonSchema,
  system: request.system, userPrompt: request.userPrompt, tail: request.jsonObjectPostlude, version: request.promptVersion });

export function canonicalPlanningCausesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(CANONICAL_PLANNING_CAUSES)) return fail("already applied");
  if (!request.wireJsonSchema || !request.promptVersion.includes(CANONICAL_PLANNING_TARGETS)) return fail("requires canonical-target indexed planning");
  const codec = new CanonicalPlanningCausesCodec(request.context);
  const replace = (text: string | undefined, original: string): string => {
    if (text?.split(original).length !== 2) return fail("requires one owned cause instruction in user prompt and tail");
    return text.replace(original, instruction);
  };
  const wireJsonSchema = codec.schema(request.wireJsonSchema);
  const userPrompt = replace(request.userPrompt, sourceIndexedPlanCausesInstruction());
  const jsonObjectPostlude = replace(request.jsonObjectPostlude, planningContractTailCauseInstruction());
  const sourceHash = requestHash(request);
  const candidate: StructuredModelRequest<T> = { ...request, wireJsonSchema, userPrompt, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${CANONICAL_PLANNING_CAUSES}@${contentHash({ context: request.context, wireJsonSchema, userPrompt, jsonObjectPostlude }).slice(0, 16)}` };
  const candidateHash = requestHash(candidate);
  candidate.preprocessOutput = raw => {
    if (requestHash(request) !== sourceHash || requestHash(candidate) !== candidateHash) return fail("request changed before decoding");
    const value = codec.decode(raw);
    return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
  };
  return candidate;
}
