import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { assertIndexedPlanningContext, planningIndexDomain, sourceIndexedPlanningInstruction, withoutPlanningIndices,
  SOURCE_INDEXED_PLAN_MEANS, type PlanningIndexDomain } from "../../mechanics/source-indexed-planning";
import { SourceIndexedPlanCauseCodec } from "../../mechanics/source-indexed-plan-causes";
import { expandRepairDiagnosticDomains } from "../../mechanics/repair-diagnostic-domains";
import { expandSharedCatalogRecords } from "../../mechanics/shared-catalog-records";
import { expandSharedCatalogPrefix } from "../../mechanics/shared-catalog-prefix";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`target-owned plans: ${message}`); };
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: ["plans"], message: `target-owned plans: ${message}` }]); };
const fields = { primary: "primaryEffect", secondary: "secondaryEffect", threatened: "threatenedEffect" } as const;
type Role = keyof typeof fields;
const roles = Object.keys(fields) as Role[];
const legacyFields = ["targetIndices", "targetRefs", ...Object.values(fields)];
const instruction = loadPromptAsset("shared/target-owned-plans.md");
export const TARGET_OWNED_PLANS = `target-owned-planning-effects-v1@${contentHash(instruction).slice(0, 16)}`;
const at = <T>(values: readonly T[], index: unknown): T | undefined =>
  typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? values[index] : undefined;

/** Restore the exact earlier indexed source and reuse its complete projection guards. */
function sourceDomain(context: unknown): PlanningIndexDomain {
  const source = structuredClone(context);
  if (!object(source) || !object(source.task) || !object(source.task.planningIndices) ||
    source.task.planningIndices.meansContract !== SOURCE_INDEXED_PLAN_MEANS) return fail("requires indexed means source");
  source.state = expandSharedCatalogPrefix(expandSharedCatalogRecords(expandRepairDiagnosticDomains(source.state)));
  delete source.task.planningActionFrames;
  const caused = structuredClone(source);
  delete source.task.planCauseChoices;
  assertIndexedPlanningContext(source);
  if (contentHash(new SourceIndexedPlanCauseCodec(source).project()) !== contentHash(caused)) return fail("cause projection changed");
  return planningIndexDomain(withoutPlanningIndices(source), true);
}

/** Explicit structural ownership only: semantic subject selection remains model-owned. */
export class TargetOwnedPlansCodec {
  readonly domain: PlanningIndexDomain;
  private readonly sourceHash: string;
  private readonly domainHash: string;

  constructor(private readonly context: unknown) {
    this.domain = sourceDomain(context);
    this.sourceHash = contentHash(context);
    this.domainHash = contentHash(this.domain);
  }

  private assertBinding(): void {
    if (contentHash(this.context) !== this.sourceHash || contentHash(this.domain) !== this.domainHash) return fail("source or domain changed before decoding");
  }

  decode(raw: unknown): unknown {
    this.assertBinding();
    const value = structuredClone(raw);
    // Original indexed decoder owns action coverage, identity and physical envelope failures.
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return value;
    value.plans = value.plans.map(plan => {
      if (!object(plan)) return plan;
      const action = at(this.domain.actions, plan.actionIndex);
      if (!action) return plan;
      const issues: string[] = [];
      if (legacyFields.some(field => Object.hasOwn(plan, field))) issues.push("mixed target representations");
      if (!Array.isArray(plan.targets)) issues.push("targets must be an explicit array");
      const copy = { ...plan }, indices: number[] = [], effects: Value = Object.fromEntries(roles.map(role => [fields[role], null]));
      const seen = new Set<string>();
      for (const [position, target] of (Array.isArray(plan.targets) ? plan.targets : []).entries()) {
        if (!object(target) || Object.keys(target).some(key => !["entityRef", "effects"].includes(key)) || !Array.isArray(target.effects)) {
          issues.push(`malformed target at ${position}`); continue;
        }
        const index = this.domain.targets.findIndex(entry => entry.handle === target.entityRef && entry.slots.includes(action.slot));
        indices.push(index);
        if (index < 0) issues.push(`unknown or cross-slot entity at ${position}`);
        for (const [ordinal, entry] of target.effects.entries()) {
          if (!object(entry) || Object.keys(entry).some(key => !["role", "effect"].includes(key)) ||
            !roles.includes(entry.role as Role) || !object(entry.effect) ||
            ["targetPosition", "targetRef"].some(key => Object.hasOwn(entry.effect as Value, key))) {
            issues.push(`malformed effect at ${position}/${ordinal}`); continue;
          }
          const role = entry.role as Role;
          if (seen.has(role)) { issues.push(`repeated ${role} role`); continue; }
          seen.add(role);
          effects[fields[role]] = { ...entry.effect, targetPosition: position };
        }
      }
      delete copy.targets;
      for (const field of legacyFields) delete copy[field];
      // Strict canonical schemas reject this marker. Preserve the entire rejected selection.
      if (issues.length) return { ...copy, targetIndices: [], primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
        invalidTargetOwnedEffects: { rejectedValue: structuredClone(plan), issues } };
      return { ...copy, targetIndices: indices, ...effects };
    });
    return value;
  }

  encode(raw: unknown): unknown {
    this.assertBinding();
    const value = structuredClone(raw);
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("missing source plans");
    for (const plan of value.plans) {
      if (!object(plan) || Object.hasOwn(plan, "targets") || !Array.isArray(plan.targetIndices) || Object.hasOwn(plan, "targetRefs")) return invalid("invalid source targets");
      const action = at(this.domain.actions, plan.actionIndex);
      if (!action) return invalid("unknown source action");
      const targets = plan.targetIndices.map(index => {
        const target = at(this.domain.targets, index);
        if (!target?.slots.includes(action.slot)) return invalid("unknown or cross-slot source target");
        return { entityRef: target.handle, effects: [] as Array<{ role: Role; effect: Value }> };
      });
      for (const role of roles) {
        const field = fields[role], effect = plan[field];
        if (effect !== null) {
          if (!object(effect) || Object.hasOwn(effect, "targetRef")) return invalid("invalid source effect");
          const target = at(targets, effect.targetPosition);
          if (!target) return invalid("effect subject absent from selected targets");
          const body = { ...effect }; delete body.targetPosition;
          target.effects.push({ role, effect: body });
        }
        delete plan[field];
      }
      delete plan.targetIndices;
      plan.targets = targets;
    }
    if (contentHash(this.decode(value)) !== contentHash(raw)) return invalid("source cannot round trip");
    return value;
  }

  schema(input: Value): Value {
    this.assertBinding();
    const schema = structuredClone(input); let plans = 0;
    const body = (source: unknown): Value | null => {
      if (!object(source)) return fail("missing effect schema");
      if (source.type === "null") return null;
      for (const union of ["anyOf", "oneOf"]) if (Array.isArray(source[union])) {
        const alternatives = source[union].map(body).filter((entry): entry is Value => entry !== null);
        return alternatives.length ? { ...source, [union]: alternatives } : null;
      }
      if (!object(source.properties) || !object(source.properties.targetPosition) || source.properties.targetPosition.type !== "integer" ||
        !Array.isArray(source.required) || !source.required.includes("targetPosition") || Object.hasOwn(source.properties, "targetRef")) return fail("unsupported effect target schema");
      const result = structuredClone(source); delete (result.properties as Value).targetPosition;
      result.required = source.required.filter(key => key !== "targetPosition");
      return result;
    };
    const nullable = (node: unknown): boolean => object(node) && (node.type === "null" ||
      [node.anyOf, node.oneOf].some(alternatives => Array.isArray(alternatives) && alternatives.some(nullable)));
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(visit); return; }
      if (!object(node)) return;
      const properties = node.properties;
      if (object(properties) && Object.hasOwn(properties, "actionIndex") && Object.hasOwn(properties, "primaryEffect")) {
        if (!object(properties.targetIndices) || properties.targetIndices.type !== "array" ||
          Object.keys(properties.targetIndices).some(key => !["type", "items", "description", "minItems", "maxItems"].includes(key)) ||
          !Array.isArray(node.required) || !legacyFields.filter(key => key !== "targetRefs").every(key => (node.required as unknown[]).includes(key)) ||
          Object.hasOwn(properties, "targets")) return fail("unsupported source plan schema");
        const alternatives = roles.flatMap(role => {
          const effect = body(properties[fields[role]]);
          return effect ? [{ type: "object", properties: { role: { type: "string", const: role }, effect }, required: ["role", "effect"], additionalProperties: false }] : [];
        });
        const requiredRoles = roles.filter(role => !nullable(properties[fields[role]]));
        const targets = { ...properties.targetIndices, description: "Ordered explicit entities and their effect roles; preserve targets with no effects.",
          items: { type: "object", properties: {
            entityRef: this.domain.targets.length ? { type: "string", enum: this.domain.targets.map(target => target.handle) } : { not: {} },
            effects: alternatives.length ? { type: "array", items: { oneOf: alternatives } } : { type: "array", maxItems: 0, items: { not: {} } },
          }, required: ["entityRef", "effects"], additionalProperties: false } };
        node.properties = Object.fromEntries(Object.entries(properties).flatMap(([key, entry]) => key === "targetIndices" ? [["targets", targets]] :
          Object.values(fields).includes(key as typeof fields[Role]) ? [] : [[key, entry]]));
        node.required = node.required.flatMap(key => key === "targetIndices" ? ["targets"] : Object.values(fields).includes(key as typeof fields[Role]) ? [] : [key]);
        if (requiredRoles.length) node.allOf = [...(Array.isArray(node.allOf) ? node.allOf : []), ...requiredRoles.map(role => ({
          properties: { targets: { contains: { properties: { effects: { contains: { properties: { role: { const: role } }, required: ["role"] } } }, required: ["effects"] } } },
        }))];
        plans++;
        return;
      }
      Object.values(node).forEach(visit);
    };
    visit(schema);
    if (!plans) return fail("missing indexed plan schema");
    return schema;
  }
}

export function targetOwnedPlansRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(TARGET_OWNED_PLANS)) return fail("already applied");
  if (!request.wireJsonSchema) return fail("missing generated schema");
  const codec = new TargetOwnedPlansCodec(request.context), wireJsonSchema = codec.schema(request.wireJsonSchema);
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
    promptVersion: `${request.promptVersion}/${TARGET_OWNED_PLANS}@${contentHash({ wireJsonSchema, system, jsonObjectPostlude, context: request.context }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(request.wireJsonSchema) !== sourceSchemaHash || contentHash(wireJsonSchema) !== schemaHash) return fail("schema changed before decoding");
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
