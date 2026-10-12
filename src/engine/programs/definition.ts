import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";

export const PROGRAM_VERSION = 1;
export const programKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).refine(
  value => !["constructor", "prototype", "__proto__"].includes(value), "unsafe program key",
);
export const programHash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const keys = z.array(programKey);
const unique = <T>(values: T[], label: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
};

export type ValueExpression =
  | { kind: "literal"; value: JsonValue }
  | { kind: "parameter"; name: string }
  | { kind: "read"; resource: string; path: string[] }
  | { kind: "arithmetic"; operation: "add" | "subtract" | "multiply" | "divide" | "min" | "max"; values: ValueExpression[] };
export const valueExpressionSchema: z.ZodType<ValueExpression> = z.lazy(() => z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.json() }).strict(),
  z.object({ kind: z.literal("parameter"), name: programKey }).strict(),
  z.object({ kind: z.literal("read"), resource: text, path: z.array(programKey) }).strict(),
  z.object({ kind: z.literal("arithmetic"), operation: z.enum(["add", "subtract", "multiply", "divide", "min", "max"]),
    values: z.array(valueExpressionSchema).min(2).max(16) }).strict(),
]));

export const predicateSchema = z.object({
  id: programKey,
  description: text,
  reads: z.array(text).min(1),
  sourceIds: keys.min(1),
  test: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("semantic"), instructions: text }).strict(),
    z.object({ kind: z.literal("mechanical"), operator: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
      left: valueExpressionSchema, right: valueExpressionSchema }).strict(),
  ]),
  unknown: z.enum(["wait", "expand"]),
}).strict();
export type ProgramPredicate = z.infer<typeof predicateSchema>;

export const programNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: programKey, kind: z.literal("attempt"), intent: text,
    entityTargetParameters: keys.describe("Only parameter names declared with kind entity. Text and number parameters are never targets, even when used in intent or utterance templates."),
    speech: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("authored"), text }).strict(),
      z.object({ kind: z.literal("create"), purpose: text }).strict(),
    ]),
    onFailure: z.enum(["wait", "expand"]), onPartial: z.enum(["wait", "expand"]) }).strict(),
  z.object({ id: programKey, kind: z.literal("sequence"), children: keys.min(1) }).strict(),
  z.object({ id: programKey, kind: z.literal("parallel"), children: keys.min(2) }).strict(),
  z.object({ id: programKey, kind: z.literal("branch"), predicateId: programKey, yes: programKey, no: programKey }).strict(),
  z.object({ id: programKey, kind: z.literal("repeat"), predicateId: programKey, body: programKey }).strict(),
  z.object({ id: programKey, kind: z.literal("wait"), predicateId: programKey, deadlineSeconds: z.number().int().positive().safe().nullable() }).strict(),
  z.object({ id: programKey, kind: z.literal("finish") }).strict(),
]);
export type ProgramNode = z.infer<typeof programNodeSchema>;

export const programDefinitionSchema = z.object({
  version: z.literal(PROGRAM_VERSION),
  id: programKey,
  name: text,
  owner: z.object({ kind: z.literal("agent"), agentId: text }).strict(),
  description: text,
  sourceIds: keys.min(1),
  parameters: z.record(programKey, z.object({ kind: z.enum(["entity", "text", "number"]), description: text }).strict()),
  reads: z.array(text).min(1).describe("Exact entries from the input resourceKeys; include every predicate read."),
  writes: z.array(text).describe("Exact entries from resourceKeys. Do not invent collection member keys."),
  entry: programKey,
  startPredicateId: programKey,
  nodes: z.array(programNodeSchema).min(1).max(512),
  predicates: z.array(predicateSchema).max(512),
  interrupts: keys,
  milestones: z.array(z.object({ id: programKey, predicateId: programKey }).strict()),
  goals: z.array(z.object({ goalId: text, predicateId: programKey }).strict()).min(1),
}).strict();
export type ProgramDefinition = z.infer<typeof programDefinitionSchema>;
export interface ProgramAdmission {
  ownerId: string;
  sources: ReadonlyMap<string, string>;
  goalIds: ReadonlySet<string>;
  resources: ReadonlySet<string>;
}
export interface AdmittedProgram {
  definition: ProgramDefinition;
  sourceHashes: Record<string, string>;
  hash: string;
  admissionHash: string;
}

export function expressionDependencies(expression: ValueExpression, depth = 0): { reads: string[]; parameters: string[] } {
  if (depth > 32) throw new Error("program expression exceeds the structural depth limit");
  if (expression.kind === "read") return { reads: [expression.resource], parameters: [] };
  if (expression.kind === "parameter") return { reads: [], parameters: [expression.name] };
  if (expression.kind === "literal") return { reads: [], parameters: [] };
  const children = expression.values.map(value => expressionDependencies(value, depth + 1));
  return { reads: children.flatMap(value => value.reads), parameters: children.flatMap(value => value.parameters) };
}

/** Admission binds a private program to one owner's actual goals and accessible resource catalog. */
export function admitProgram(input: unknown, admission: ProgramAdmission): AdmittedProgram {
  assertJsonValue(input, "program");
  const definition = programDefinitionSchema.parse(input);
  if (definition.owner.agentId !== admission.ownerId) throw new Error("program owner differs from the authorized Agent");
  const sourceHashes = Object.fromEntries(definition.sourceIds.map(id => {
    const hash = admission.sources.get(id); if (!hash) throw new Error(`unknown program source ${id}`);
    return [id, programHash.parse(hash)];
  }));
  for (const resource of [...definition.reads, ...definition.writes]) {
    if (!admission.resources.has(resource)) throw new Error(`unauthorized program resource ${resource}`);
  }
  unique(definition.nodes.map(node => node.id), "program node");
  unique(definition.predicates.map(predicate => predicate.id), "program predicate");
  unique(definition.milestones.map(milestone => milestone.id), "program milestone");
  unique(definition.goals.map(goal => goal.goalId), "program goal");
  for (const values of [definition.sourceIds, definition.reads, definition.writes, definition.interrupts]) unique(values, "program declaration");
  const nodes = new Map(definition.nodes.map(node => [node.id, node]));
  const predicates = new Set(definition.predicates.map(predicate => predicate.id));
  const predicateRef = (id: string) => { if (!predicates.has(id)) throw new Error(`unknown predicate ${id}`); };
  predicateRef(definition.startPredicateId);
  for (const predicate of definition.predicates) {
    unique(predicate.reads, "predicate read"); unique(predicate.sourceIds, "predicate source");
    for (const read of predicate.reads) if (!definition.reads.includes(read)) throw new Error(`undeclared predicate read ${read}`);
    for (const source of predicate.sourceIds) if (!definition.sourceIds.includes(source)) throw new Error(`undeclared predicate source ${source}`);
    if (predicate.test.kind === "mechanical") {
      for (const expression of [predicate.test.left, predicate.test.right]) {
        const used = expressionDependencies(expression);
        for (const read of used.reads) if (!predicate.reads.includes(read)) throw new Error(`undeclared expression read ${read}`);
        for (const parameter of used.parameters) if (!Object.hasOwn(definition.parameters, parameter)) throw new Error(`unknown parameter ${parameter}`);
      }
    }
  }
  for (const id of definition.interrupts) predicateRef(id);
  for (const milestone of definition.milestones) predicateRef(milestone.predicateId);
  for (const goal of definition.goals) {
    if (!admission.goalIds.has(goal.goalId)) throw new Error(`unknown owner goal ${goal.goalId}`);
    predicateRef(goal.predicateId);
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (depth > 64) throw new Error("program nesting exceeds 64 levels");
    if (active.has(id)) throw new Error("program graph cycles require an explicit repeat node");
    if (visited.has(id)) throw new Error("program nodes require one structural parent");
    const node = nodes.get(id); if (!node) throw new Error(`unknown program node ${id}`);
    visited.add(id); active.add(id);
    if (node.kind === "attempt") {
      unique(node.entityTargetParameters, "attempt target parameter");
      for (const name of node.entityTargetParameters) if (definition.parameters[name]?.kind !== "entity") throw new Error(`attempt target ${name} is not an entity parameter`);
      for (const value of [node.intent, node.speech.kind === "authored" ? node.speech.text : node.speech.kind === "create" ? node.speech.purpose : ""]) {
        for (const [, name] of value.matchAll(/\{([a-zA-Z0-9_.:-]+)\}/gu)) {
          if (!Object.hasOwn(definition.parameters, name!)) throw new Error(`unknown template parameter ${name}`);
        }
      }
    } else if (node.kind === "sequence" || node.kind === "parallel") {
      unique(node.children, "node child"); node.children.forEach(child => visit(child, depth + 1));
    } else if (node.kind !== "finish") {
      predicateRef(node.predicateId);
      if (node.kind === "branch") { visit(node.yes, depth + 1); visit(node.no, depth + 1); }
      else if (node.kind === "repeat") visit(node.body, depth + 1);
    }
    active.delete(id);
  };
  visit(definition.entry, 0);
  if (visited.size !== nodes.size) throw new Error("program contains unreachable nodes");
  return frozenClone({ definition, sourceHashes, hash: contentHash({ definition, sourceHashes }), admissionHash: contentHash({ ownerId: admission.ownerId,
    sources: Object.fromEntries(admission.sources), goals: [...admission.goalIds].sort(), resources: [...admission.resources].sort() }) });
}

export interface VersionedResource { version: number; value: JsonValue }
export type ProgramResources = Readonly<Record<string, VersionedResource>>;

export function evaluateExpression(expression: ValueExpression, parameters: Readonly<Record<string, JsonValue>>, resources: ProgramResources): JsonValue {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "parameter") {
    if (!Object.hasOwn(parameters, expression.name)) throw new Error(`missing parameter ${expression.name}`);
    return parameters[expression.name]!;
  }
  if (expression.kind === "read") {
    const resource = resources[expression.resource]; if (!resource) throw new Error(`missing resource ${expression.resource}`);
    let value: JsonValue = resource.value;
    for (const key of expression.path) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error(`missing field ${key}`);
      value = (value as Record<string, JsonValue>)[key]!;
    }
    return value;
  }
  const values = expression.values.map(value => evaluateExpression(value, parameters, resources));
  if (!values.every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("arithmetic requires finite numbers");
  const numbers = values as number[];
  const [first, ...rest] = numbers;
  const value = expression.operation === "min" ? Math.min(...numbers) : expression.operation === "max" ? Math.max(...numbers)
    : rest.reduce((a, b) => expression.operation === "add" ? a + b : expression.operation === "subtract" ? a - b
      : expression.operation === "multiply" ? a * b : a / b, first!);
  if (!Number.isFinite(value)) throw new Error("program arithmetic is not finite");
  return value;
}

export function bindProgram(program: AdmittedProgram, parameters: Record<string, JsonValue>, entityIds: ReadonlySet<string>) {
  assertJsonValue(parameters, "program parameters");
  if (contentHash({ definition: program.definition, sourceHashes: program.sourceHashes }) !== program.hash) throw new Error("program definition hash mismatch");
  if (Object.keys(parameters).sort().join("\n") !== Object.keys(program.definition.parameters).sort().join("\n")) throw new Error("program parameters do not match the definition");
  for (const [name, parameter] of Object.entries(program.definition.parameters)) {
    const value = parameters[name];
    if (parameter.kind === "entity" && (typeof value !== "string" || !entityIds.has(value))) throw new Error(`invalid entity parameter ${name}`);
    if (parameter.kind === "text" && typeof value !== "string") throw new Error(`invalid text parameter ${name}`);
    if (parameter.kind === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`invalid numeric parameter ${name}`);
  }
  return frozenClone(parameters);
}
