import type { CausalSource } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { decisionPrompt, nativeDecisionBounds, validateDecisionResult, type DecisionBatch, type DecisionResult } from "../models/decision";
import { DecisionRuntime, type DecisionUse, type ProgramDecisionScope } from "../programs/decision-runtime";
import { evaluateExpression, type ProgramResources } from "../programs/definition";
import { loadPromptAsset } from "../prompts";
import { frozenClone, type JsonValue } from "../runtime/json";
import { validateModelAudit } from "../runtime/transaction";
import { bindWorldExpression, materializeWorldBranch, renderWorldText, type AdmittedWorldProgram } from "./world-program";
import { captureReads, type ReadSet } from "./resources";

export interface WorldAttempt {
  id: string;
  actorId: string;
  actorEntityId: string;
  intent: string;
  utterance: string | null;
  targetEntityIds: string[];
  startedAtSeconds: number;
  program: { instanceId: string; workId: string; requestHash: string } | null;
}
export interface BoundWorldProgram {
  program: AdmittedWorldProgram;
  parameters: Record<string, JsonValue>;
  attempt: WorldAttempt;
}
export interface WorldDecisionEvidence { batch: DecisionBatch; result: DecisionResult; hash: string }
export type WorldVerdict = "yes" | "no" | "unknown";
export interface WorldConditionRecord {
  ruleHash: string; attemptHash: string; conditionId: string; verdict: WorldVerdict;
  readSet: ReadSet; evidenceHash: string; questionId: string | null;
}
export interface WorldAdjudication {
  records: WorldConditionRecord[];
  evidence: WorldDecisionEvidence[];
  calls: DecisionUse[];
}
export function worldProvenance(bound: BoundWorldProgram): CausalSource {
  return { causes: [{ kind: "action", id: bound.attempt.id },
    ...Object.keys(bound.program.sourceHashes).filter(id => id.startsWith("law:")).map(id => ({ kind: "law" as const, id: id.slice(4) }))],
    assertions: [{ kind: "entity_lifecycle", entityId: bound.attempt.actorEntityId, expected: "active" }] };
}
export function worldProgramDuration(bound: BoundWorldProgram, resources: ProgramResources): number {
  const value = evaluateExpression(bindWorldExpression(bound.program.definition.durationSeconds, bound.parameters), bound.parameters, resources);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("world program duration must be positive integer seconds");
  return value;
}
function actualKeys(bound: BoundWorldProgram, templates: string[]) { return templates.map(key => renderWorldText(key, bound.parameters)); }
function compare(left: JsonValue, operator: string, right: JsonValue): WorldVerdict {
  if (operator === "eq" || operator === "ne") return (contentHash(left) === contentHash(right)) === (operator === "eq") ? "yes" : "no";
  if (typeof left !== "number" || typeof right !== "number") throw new Error("ordered world condition requires numeric operands");
  return (operator === "lt" ? left < right : operator === "lte" ? left <= right : operator === "gt" ? left > right : left >= right) ? "yes" : "no";
}
export function mechanicalWorldCondition(bound: BoundWorldProgram, id: string, resources: ProgramResources): WorldVerdict | null {
  const condition = bound.program.definition.predicates.find(value => value.id === id);
  if (!condition) throw new Error(`unknown world condition ${id}`);
  if (condition.test.kind !== "mechanical") return null;
  const evaluate = (value: import("../programs/definition").ValueExpression) => evaluateExpression(bindWorldExpression(value, bound.parameters), bound.parameters, resources);
  return compare(evaluate(condition.test.left), condition.test.operator, evaluate(condition.test.right));
}
interface QuestionWork { bound: BoundWorldProgram; id: string; instructions: string; reads: string[]; payload: JsonValue; version: string }

/** Every world judgment sees the actual participants and containment chain, regardless of generated read declarations. */
function physicalReadKeys(component: readonly WorldAttempt[], resources: ProgramResources): string[] {
  const entities = new Set<string>(), keys = new Set<string>(["laws"]);
  const visit = (id: string) => {
    if (entities.has(id)) return; entities.add(id);
    keys.add(`entity:${id}`); keys.add(`placement:${id}`);
    const parent = resources[`placement:${id}`]?.value;
    if (typeof parent === "string") visit(parent);
  };
  for (const attempt of component) [attempt.actorEntityId, ...attempt.targetEntityIds].forEach(visit);
  for (const [key, resource] of Object.entries(resources)) if (key.startsWith("condition:") && resource.value && typeof resource.value === "object" &&
    "subjectId" in resource.value && typeof resource.value.subjectId === "string" && entities.has(resource.value.subjectId)) keys.add(key);
  return [...keys];
}

export function worldQuestionWork(bound: BoundWorldProgram, resources: ProgramResources): QuestionWork[] {
  const instruction = loadPromptAsset("shared/world-program-decision.md"), definition = bound.program.definition;
  const questions: QuestionWork[] = definition.predicates.filter(condition => condition.test.kind === "semantic").map(condition => ({
    bound, id: condition.id, reads: actualKeys(bound, condition.reads), payload: { condition },
    instructions: `${instruction}\n\nCondition: ${condition.description}\n${condition.test.kind === "semantic" ? condition.test.instructions : ""}`,
    version: contentHash(condition),
  }));
  for (const branch of definition.branches) {
    questions.push({ bound, id: `effect:${branch.id}`, reads: actualKeys(bound, definition.reads),
      payload: { branch, durationSeconds: worldProgramDuration(bound, resources),
        operations: JSON.parse(JSON.stringify(materializeWorldBranch(bound.program, branch.id, bound.parameters, resources, worldProvenance(bound)))) as JsonValue,
        deliveries: branch.deliveries.map(delivery => ({ recipientEntityId: bound.parameters[delivery.recipientParameter]!,
          text: renderWorldText(delivery.text, bound.parameters), kind: delivery.kind })) },
      instructions: `${instruction}\n\nAre all candidate effects, delivery, duration, and the outcome justified if the listed branch conditions hold? Evaluate this exact branch for the actual attempt.`,
      version: contentHash({ branch, instruction }),
    });
  }
  return questions;
}

/** Questions are independent within a physical component. All interaction partners remain in every partition. */
export function makeWorldDecisionBatch(work: QuestionWork[], component: readonly WorldAttempt[], resources: ProgramResources,
  sources: Readonly<Record<string, JsonValue>>): DecisionBatch {
  const keys = [...new Set([...work.flatMap(item => item.reads), ...physicalReadKeys(component, resources)])].sort();
  captureReads(resources, keys);
  const state = { attempts: component as unknown as JsonValue,
    resources: Object.fromEntries(keys.map(key => [key, resources[key]!])),
    questions: Object.fromEntries(work.map((item, index) => [`q${index}`, { attemptId: item.bound.attempt.id,
      parameters: item.bound.parameters, rule: { id: item.bound.program.definition.id, description: item.bound.program.definition.description },
      sources: Object.fromEntries(Object.keys(item.bound.program.sourceHashes).map(id => [id, sources[id]!])), payload: item.payload }])) };
  return { version: 1, view: { kind: "world", projectionHash: contentHash(state) },
    programHash: contentHash(work.map(item => item.bound.program.hash)), state: state as unknown as JsonValue,
    dependencies: Object.fromEntries(keys.map(key => [key, resources[key]!.version])),
    questions: Object.fromEntries(work.map((item, index) => [`q${index}`, { version: item.version,
      instructions: `${item.instructions}\nEvaluate questions.q${index} in state for attempt ${item.bound.attempt.id}.`,
      criteria: { yes: "The sources and evidence support this specific condition or complete candidate effect.",
        no: "The sources or evidence contradict it, or the candidate claims an unsupported effect.",
        unknown: "Required evidence is absent; do not assume consent, completion, or information delivery." },
      sources: Object.keys(item.bound.program.sourceHashes) }])) };
}

export function validateWorldEvidence(evidence: WorldDecisionEvidence): void {
  const { batch, result, hash } = evidence;
  if (hash !== contentHash({ batch, result }) || batch.view.kind !== "world" || result.view.kind !== "world" ||
    batch.view.projectionHash !== contentHash(batch.state) || result.inputHash !== contentHash({ batch, promptVersion: decisionPrompt().version }) ||
    contentHash(result.questions) !== contentHash(batch.questions) || contentHash(result.dependencies) !== contentHash(batch.dependencies) ||
    result.programHash !== batch.programHash || contentHash(result.view) !== contentHash(batch.view) || result.audit.role !== "decision" ||
    result.audit.promptVersion !== decisionPrompt().version) throw new Error("world decision evidence is not bound to its input");
  validateModelAudit(result.audit, "world decision");
  validateDecisionResult(batch, result);
  if (contentHash(Object.keys(result.answers).sort()) !== contentHash(Object.keys(batch.questions).sort())) throw new Error("world decision answer membership mismatch");
  for (const [id, answer] of Object.entries(result.answers)) if (!Object.hasOwn(batch.questions[id]!.criteria, answer.choice)) throw new Error("world decision choice is outside its domain");
}

export async function adjudicateWorldPrograms(runtime: DecisionRuntime, programs: BoundWorldProgram[], resources: ProgramResources,
  sources: Readonly<Record<string, JsonValue>>, scope: ProgramDecisionScope): Promise<WorldAdjudication> {
  if (!programs.length) throw new Error("cannot adjudicate an empty component");
  const records: WorldConditionRecord[] = [], evidence: WorldDecisionEvidence[] = [], calls: DecisionUse[] = [];
  for (const bound of programs) for (const condition of bound.program.definition.predicates) {
    const verdict = mechanicalWorldCondition(bound, condition.id, resources);
    if (verdict !== null) {
      const record = { ruleHash: bound.program.hash, attemptHash: contentHash(bound.attempt), conditionId: condition.id, verdict,
        readSet: captureReads(resources, actualKeys(bound, condition.reads)), questionId: null };
      records.push({ ...record, evidenceHash: contentHash({ evaluator: "world-mechanical-v1", ...record }) });
    }
  }
  const component = programs.map(program => program.attempt), all = programs.flatMap(bound => worldQuestionWork(bound, resources));
  const partitions: QuestionWork[][] = []; let current: QuestionWork[] = [];
  for (const work of all) {
    const next = [...current, work];
    if (current.length && !nativeDecisionBounds(makeWorldDecisionBatch(next, component, resources, sources)).fits) { partitions.push(current); current = [work]; }
    else current = next;
  }
  if (current.length) partitions.push(current);
  for (const partition of partitions) {
    const batch = makeWorldDecisionBatch(partition, component, resources, sources);
    const call = await runtime.decide({ ...scope, batch, subjectId: "world", modelInvocation: scope.nextInvocation() }); calls.push(call);
    const proof = { batch, result: call.result, hash: contentHash({ batch, result: call.result }) }; validateWorldEvidence(proof); evidence.push(proof);
    for (const [index, work] of partition.entries()) {
      const id = `q${index}`, verdict = call.result.answers[id]!.choice;
      if (verdict !== "yes" && verdict !== "no" && verdict !== "unknown") throw new Error("invalid world verdict");
      records.push({ ruleHash: work.bound.program.hash, attemptHash: contentHash(work.bound.attempt), conditionId: work.id, verdict,
        // A merged request reads the full union supplied to the model, not just this question's intended subset.
        readSet: captureReads(resources, Object.keys(batch.dependencies)), evidenceHash: proof.hash, questionId: id });
    }
  }
  return frozenClone({ records, evidence, calls });
}
