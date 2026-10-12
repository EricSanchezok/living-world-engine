import { z } from "zod";
import type { CausalSource, WorldDeltaOperation } from "../contracts/model";
import { worldDeltaOperationSchema } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { evaluateExpression, expressionDependencies, programHash, programKey, valueExpressionSchema, type ProgramResources, type ValueExpression } from "../programs/definition";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";

const text = z.string().trim().min(1);
export type WorldValue = JsonValue;
// JSON-shaped templates avoid wrapping every nested field in another tagged AST node.
// $expression/$text/$literal are the only reserved, single-key operators.
export const worldValueSchema = z.json();
const predicate = z.object({ id: programKey, description: text, reads: z.array(text).min(1), sourceIds: z.array(programKey).min(1),
  test: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("semantic"), instructions: text }).strict(),
    z.object({ kind: z.literal("mechanical"), operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]), left: valueExpressionSchema, right: valueExpressionSchema }).strict(),
  ]), unknown: z.enum(["wait", "expand"]) }).strict();
const timing = z.object({ profileId: programKey, basis: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile") }).strict(),
  z.object({ kind: z.literal("explicit_duration"), seconds: valueExpressionSchema, sourceText: text }).strict(),
  z.object({ kind: z.literal("explicit_quantity"), amount: valueExpressionSchema, unit: text, sourceText: text }).strict(),
]) }).strict();
export const worldProgramSchema = z.object({
  version: z.literal(1), namespace: z.literal("world"), id: programKey, description: text,
  sourceIds: z.array(programKey).min(1), parameters: z.record(programKey, z.object({ kind: z.enum(["entity", "text", "number"]), description: text }).strict()),
  reads: z.array(text).min(1), writes: z.array(text), timing,
  predicates: z.array(predicate).min(1),
  branches: z.array(z.object({ id: programKey,
    when: z.array(z.object({ predicateId: programKey, equals: z.enum(["yes", "no"]) }).strict()).min(1),
    outcome: z.enum(["succeeded", "partial", "failed", "blocked"]), description: text,
    effects: z.array(z.object({ kind: z.enum(["create_entity", "retire_entity", "place_entity", "set_fact", "remove_fact", "set_meter", "adjust_meter",
      "transfer_quantity", "produce_quantity", "consume_quantity", "set_rating", "set_condition", "remove_condition", "set_shared_activity_resource_capacity",
      "create_agent", "remove_agent"]), fields: z.record(programKey, worldValueSchema) }).strict()),
    // Delivery is an explicit effect. A proposed recipient does not receive anything until this branch commits.
    deliveries: z.array(z.object({ recipientParameter: programKey, text: text, kind: z.enum(["speech", "observation"]) }).strict()),
  }).strict()).min(1).max(64),
}).strict();
export type WorldProgramDefinition = z.infer<typeof worldProgramSchema>;
export interface AdmittedWorldProgram { definition: WorldProgramDefinition; sourceHashes: Record<string, string>; hash: string }

const templateParameters = (template: string) => [...template.matchAll(/\{([a-zA-Z0-9_.:-]+)\}/gu)].map(match => match[1]!);
export function renderWorldText(template: string, parameters: Readonly<Record<string, JsonValue>>): string {
  return template.replace(/\{([a-zA-Z0-9_.:-]+)\}/gu, (_, name: string) => {
    if (!Object.hasOwn(parameters, name) || typeof parameters[name] === "object") throw new Error(`missing scalar world parameter ${name}`);
    return String(parameters[name]);
  });
}
export function bindWorldExpression(expression: ValueExpression, parameters: Readonly<Record<string, JsonValue>>): ValueExpression {
  if (expression.kind === "read") return { ...expression, resource: renderWorldText(expression.resource, parameters) };
  if (expression.kind === "arithmetic") return { ...expression, values: expression.values.map(value => bindWorldExpression(value, parameters)) };
  return expression;
}
export function evaluateWorldValue(value: WorldValue, parameters: Readonly<Record<string, JsonValue>>, resources: ProgramResources): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => evaluateWorldValue(item, parameters, resources));
  const object = value as Readonly<Record<string, JsonValue>>;
  if (Object.hasOwn(object, "$literal")) return object.$literal!;
  if (Object.hasOwn(object, "$text")) return renderWorldText(z.string().parse(object.$text), parameters);
  if (Object.hasOwn(object, "$expression")) return evaluateExpression(bindWorldExpression(valueExpressionSchema.parse(object.$expression), parameters), parameters, resources);
  return Object.fromEntries(Object.entries(object).map(([key, field]) => [key, evaluateWorldValue(field, parameters, resources)]));
}

/** Only declaration syntax is admitted here. Each execution separately proves rule applicability and every candidate effect. */
export function admitWorldProgram(input: unknown, sources: Readonly<Record<string, JsonValue>>): AdmittedWorldProgram {
  assertJsonValue(input, "world program");
  const definition = worldProgramSchema.parse(input);
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`); };
  unique(definition.sourceIds, "world source"); unique(definition.reads, "world read"); unique(definition.writes, "world write");
  unique(definition.predicates.map(value => value.id), "world predicate"); unique(definition.branches.map(value => value.id), "world branch");
  if (definition.parameters.actor?.kind !== "entity") throw new Error("world programs require the actor entity parameter");
  const sourceHashes = Object.fromEntries(definition.sourceIds.map(id => {
    if (!Object.hasOwn(sources, id)) throw new Error(`unknown world program source ${id}`);
    return [id, contentHash(sources[id])];
  }));
  const checkText = (value: string) => {
    for (const parameter of templateParameters(value)) if (!Object.hasOwn(definition.parameters, parameter)) throw new Error(`unknown world parameter ${parameter}`);
  };
  const checkExpression = (expression: ValueExpression, reads: string[]) => {
    const dependencies = expressionDependencies(expression);
    for (const read of dependencies.reads) {
      checkText(read); if (!reads.includes(read)) throw new Error(`undeclared world expression read ${read}`);
    }
    for (const parameter of dependencies.parameters) if (!Object.hasOwn(definition.parameters, parameter)) throw new Error(`unknown world parameter ${parameter}`);
  };
  const checkValue = (value: WorldValue, depth = 0): void => {
    if (depth > 32) throw new Error("world value nesting exceeds 32 levels");
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(child => checkValue(child, depth + 1)); return; }
    const object = value as Readonly<Record<string, JsonValue>>;
    const reserved = Object.keys(object).filter(key => key.startsWith("$"));
    if (reserved.length) {
      if (Object.keys(value).length !== 1 || !["$expression", "$text", "$literal"].includes(reserved[0]!)) throw new Error("invalid world value operator");
      if (reserved[0] === "$expression") checkExpression(valueExpressionSchema.parse(object.$expression), definition.reads);
      if (reserved[0] === "$text") checkText(z.string().parse(object.$text));
    } else for (const [key, child] of Object.entries(value)) { programKey.parse(key); checkValue(child, depth + 1); }
  };
  definition.reads.forEach(checkText); definition.writes.forEach(checkText);
  if (definition.timing.basis.kind !== "profile") {
    const basis = definition.timing.basis; checkText(basis.sourceText);
    checkExpression(basis.kind === "explicit_duration" ? basis.seconds : basis.amount, definition.reads);
  }
  for (const condition of definition.predicates) {
    if (condition.id.startsWith("effect:")) throw new Error("world predicate uses an engine-owned effect identifier");
    unique(condition.reads, "world predicate read"); unique(condition.sourceIds, "world predicate source");
    for (const id of condition.sourceIds) if (!definition.sourceIds.includes(id)) throw new Error(`undeclared world source ${id}`);
    for (const read of condition.reads) if (!definition.reads.includes(read)) throw new Error(`undeclared world predicate read ${read}`);
    if (condition.test.kind === "mechanical") {
      checkExpression(condition.test.left, condition.reads); checkExpression(condition.test.right, condition.reads);
    }
  }
  for (const branch of definition.branches) {
    unique(branch.when.map(value => value.predicateId), "branch condition"); checkText(branch.description);
    if (!branch.when.some(value => definition.predicates.find(predicate => predicate.id === value.predicateId)?.test.kind === "semantic")) {
      throw new Error("world branches require source-bound semantic applicability");
    }
    for (const condition of branch.when) if (!definition.predicates.some(value => value.id === condition.predicateId)) throw new Error(`unknown branch predicate ${condition.predicateId}`);
    for (const effect of branch.effects) {
      if (["kind", "causes", "assertions"].some(key => Object.hasOwn(effect.fields, key))) throw new Error("effect provenance is owned by the kernel");
      Object.values(effect.fields).forEach(value => checkValue(value));
    }
    for (const delivery of branch.deliveries) {
      if (definition.parameters[delivery.recipientParameter]?.kind !== "entity") throw new Error("delivery recipient must be an entity parameter");
      checkText(delivery.text);
    }
  }
  return frozenClone({ definition, sourceHashes, hash: contentHash({ definition, sourceHashes }) });
}

export function bindWorldProgram(program: AdmittedWorldProgram, parameters: Readonly<Record<string, JsonValue>>, entities: ReadonlySet<string>): void {
  programHash.parse(program.hash);
  if (contentHash({ definition: program.definition, sourceHashes: program.sourceHashes }) !== program.hash) throw new Error("world program hash mismatch");
  if (contentHash(Object.keys(parameters).sort()) !== contentHash(Object.keys(program.definition.parameters).sort())) throw new Error("world parameter membership mismatch");
  for (const [name, declaration] of Object.entries(program.definition.parameters)) {
    const value = parameters[name];
    if (declaration.kind === "entity" && (typeof value !== "string" || !entities.has(value))) throw new Error(`unknown bound world entity ${name}`);
    if (declaration.kind === "text" && typeof value !== "string") throw new Error(`invalid world text parameter ${name}`);
    if (declaration.kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`invalid world number parameter ${name}`);
  }
}

export function materializeWorldBranch(program: AdmittedWorldProgram, branchId: string, parameters: Readonly<Record<string, JsonValue>>,
  resources: ProgramResources, provenance: CausalSource): WorldDeltaOperation[] {
  const branch = program.definition.branches.find(branch => branch.id === branchId); if (!branch) throw new Error(`unknown world branch ${branchId}`);
  return branch.effects.map(effect => {
    const fields = Object.fromEntries(Object.entries(effect.fields).map(([key, value]) => [key, evaluateWorldValue(value, parameters, resources)]));
    // Fact/condition provenance cannot smuggle extra authority through a nested object.
    for (const key of ["fact", "condition"]) if (fields[key] && typeof fields[key] === "object" && !Array.isArray(fields[key])) {
      fields[key] = { ...fields[key] as Record<string, JsonValue>, provenance: provenance.causes as unknown as JsonValue };
    }
    return worldDeltaOperationSchema.parse({ kind: effect.kind, ...fields, ...provenance });
  });
}
