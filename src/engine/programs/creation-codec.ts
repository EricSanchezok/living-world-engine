import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { expressionDependencies, predicateSchema, programKey, programNodeSchema,
  type ProgramDefinition, type ProgramNode, type ProgramPredicate } from "./definition";
import type { JsonValue } from "../runtime/json";

const conditionSchema = predicateSchema.omit({ id: true });
type ConditionDraft = z.infer<typeof conditionSchema>;
type Attempt = Omit<Extract<ProgramNode, { kind: "attempt" }>, "id">;
export type BehaviorNode = Attempt
  | { kind: "sequence"; children: BehaviorNode[] }
  | { kind: "parallel"; children: BehaviorNode[] }
  | { kind: "branch"; condition: ConditionDraft; yes: BehaviorNode; no: BehaviorNode }
  | { kind: "repeat"; condition: ConditionDraft; body: BehaviorNode }
  | { kind: "wait"; condition: ConditionDraft; deadlineSeconds: number | null }
  | { kind: "finish" };

function behaviorSchema(condition: z.ZodType<ConditionDraft>): z.ZodType<BehaviorNode> {
  const behaviorNodeSchema: z.ZodType<BehaviorNode> = z.lazy(() => z.discriminatedUnion("kind", [
  programNodeSchema.options[0].omit({ id: true }),
  z.object({ kind: z.literal("sequence"), children: z.array(behaviorNodeSchema).min(1) }).strict(),
  z.object({ kind: z.literal("parallel"), children: z.array(behaviorNodeSchema).min(2) }).strict(),
  z.object({ kind: z.literal("branch"), condition, yes: behaviorNodeSchema, no: behaviorNodeSchema }).strict(),
  z.object({ kind: z.literal("repeat"), condition, body: behaviorNodeSchema }).strict(),
  z.object({ kind: z.literal("wait"), condition, deadlineSeconds: z.number().int().positive().safe().nullable() }).strict(),
  z.object({ kind: z.literal("finish") }).strict(),
]));
  return behaviorNodeSchema;
}

/** The creation model writes a structured tree. It never assigns graph IDs or duplicates parameter bindings. */
export function programDraftSchema(entityIds: readonly string[], catalogs?: { resources: string[]; sources: string[]; goals: string[] }) {
  const entity = entityIds.length ? z.enum([...entityIds] as [string, ...string[]]) : z.never();
  const description = z.string().trim().min(1);
  const domain = (values?: string[]) => values ? values.length ? z.enum(values as [string, ...string[]]) : z.never() : z.string().min(1);
  const resource = domain(catalogs?.resources), source = domain(catalogs?.sources), goal = domain(catalogs?.goals);
  const condition = conditionSchema.extend({ reads: z.array(resource).min(1), sourceIds: z.array(source).min(1) });
  return z.object({
    version: z.literal(1), name: description, description,
    sourceIds: z.array(source).min(1), dependencies: z.array(resource), writes: z.array(resource),
    parameters: z.record(programKey, z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("entity"), description, value: entity }).strict(),
      z.object({ kind: z.literal("text"), description, value: z.string() }).strict(),
      z.object({ kind: z.literal("number"), description, value: z.number().finite() }).strict(),
    ])),
    start: condition, interrupts: z.array(condition),
    milestones: z.array(z.object({ id: programKey, condition }).strict()),
    goals: z.array(z.object({ goalId: goal, condition }).strict()).min(1),
    body: behaviorSchema(condition),
  }).strict();
}
export type ProgramDraft = z.infer<ReturnType<typeof programDraftSchema>>;

/** Lossless structural lowering; only supplied conditions, intentions, and values enter the executable definition. */
export function lowerProgramDraft(draft: ProgramDraft, ownerId: string): { definition: ProgramDefinition; parameters: Record<string, JsonValue> } {
  const nodes: ProgramNode[] = [], predicates = new Map<string, ProgramPredicate>();
  const reads = new Set(draft.dependencies), sources = new Set(draft.sourceIds);
  const condition = (input: ConditionDraft) => {
    const expressionReads = input.test.kind === "mechanical"
      ? [...expressionDependencies(input.test.left).reads, ...expressionDependencies(input.test.right).reads] : [];
    const normalized = { ...input, reads: [...new Set([...input.reads, ...expressionReads])].sort(), sourceIds: [...new Set(input.sourceIds)].sort() };
    normalized.reads.forEach(key => reads.add(key)); normalized.sourceIds.forEach(id => sources.add(id));
    const id = `p:${contentHash(normalized).slice(0, 32)}`;
    predicates.set(id, { id, ...normalized }); return id;
  };
  let count = 0;
  const lower = (node: BehaviorNode, position: string, depth: number): string => {
    if (++count > 512 || depth > 32) throw new Error("behavior tree exceeds executable program bounds");
    const id = `n:${position}`;
    if (node.kind === "sequence" || node.kind === "parallel") nodes.push({ id, kind: node.kind,
      children: node.children.map((child, index) => lower(child, `${position}.${index}`, depth + 1)) });
    else if (node.kind === "branch") nodes.push({ id, kind: node.kind, predicateId: condition(node.condition),
      yes: lower(node.yes, `${position}.yes`, depth + 1), no: lower(node.no, `${position}.no`, depth + 1) });
    else if (node.kind === "repeat") nodes.push({ id, kind: node.kind, predicateId: condition(node.condition), body: lower(node.body, `${position}.repeat`, depth + 1) });
    else if (node.kind === "wait") nodes.push({ id, kind: node.kind, predicateId: condition(node.condition), deadlineSeconds: node.deadlineSeconds });
    else nodes.push({ id, ...node });
    return id;
  };
  const entry = lower(draft.body, "0", 0), startPredicateId = condition(draft.start);
  const interrupts = draft.interrupts.map(condition), milestones = draft.milestones.map(value => ({ id: value.id, predicateId: condition(value.condition) }));
  const goals = draft.goals.map(value => ({ goalId: value.goalId, predicateId: condition(value.condition) }));
  const definition: ProgramDefinition = { version: 1, id: `behavior:${contentHash(draft)}`, name: draft.name, description: draft.description,
    owner: { kind: "agent", agentId: ownerId }, parameters: Object.fromEntries(Object.entries(draft.parameters)
      .map(([key, value]) => [key, { kind: value.kind, description: value.description }])),
    sourceIds: [...sources].sort(), reads: [...reads].sort(), writes: [...new Set(draft.writes)].sort(),
    entry, startPredicateId, nodes, predicates: [...predicates.values()], interrupts: [...new Set(interrupts)], milestones, goals };
  return { definition, parameters: Object.fromEntries(Object.entries(draft.parameters).map(([key, value]) => [key, value.value])) };
}

/** Render a rejected executable candidate in the creation vocabulary while retaining its original audit separately. */
export function encodeProgramDraft(definition: ProgramDefinition, parameters: Record<string, JsonValue>): ProgramDraft {
  const condition = (id: string): ConditionDraft => {
    const value = definition.predicates.find(value => value.id === id); if (!value) throw new Error(`missing encoded condition ${id}`);
    return conditionSchema.strip().parse(value);
  };
  const encode = (id: string): BehaviorNode => {
    const node = definition.nodes.find(value => value.id === id); if (!node) throw new Error(`missing encoded node ${id}`);
    if (node.kind === "sequence" || node.kind === "parallel") return { kind: node.kind, children: node.children.map(encode) };
    if (node.kind === "branch") return { kind: node.kind, condition: condition(node.predicateId), yes: encode(node.yes), no: encode(node.no) };
    if (node.kind === "repeat") return { kind: node.kind, condition: condition(node.predicateId), body: encode(node.body) };
    if (node.kind === "wait") return { kind: node.kind, condition: condition(node.predicateId), deadlineSeconds: node.deadlineSeconds };
    return node.kind === "attempt" ? programNodeSchema.options[0].omit({ id: true }).strip().parse(node) : { kind: "finish" };
  };
  return programDraftSchema(Object.entries(definition.parameters).filter(([, value]) => value.kind === "entity")
    .map(([key]) => String(parameters[key]))).parse({ version: 1, name: definition.name, description: definition.description,
    sourceIds: definition.sourceIds, dependencies: definition.reads, writes: definition.writes,
    parameters: Object.fromEntries(Object.entries(definition.parameters).map(([key, value]) => [key, { ...value, value: parameters[key] }])),
    start: condition(definition.startPredicateId), interrupts: definition.interrupts.map(condition),
    milestones: definition.milestones.map(value => ({ id: value.id, condition: condition(value.predicateId) })),
    goals: definition.goals.map(value => ({ goalId: value.goalId, condition: condition(value.predicateId) })), body: encode(definition.entry) });
}
