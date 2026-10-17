import type { JsonValue } from "../runtime/json";
import type { DecisionBatchV2, DecisionQuestionV2 } from "./decision-v2";

export const decisionQuestionLayout = "shared-templates-v1";
type DataPath = "data" | "original.data";
interface QuestionTemplate {
  question: DecisionQuestionV2;
  dataPath?: DataPath;
}
interface QuestionReference { id: string; template: string; data?: JsonValue }
export interface TemplatedDecisionBatchV2 extends Omit<DecisionBatchV2, "questions"> {
  questionLayout: typeof decisionQuestionLayout;
  questionTemplates: Record<string, QuestionTemplate>;
  questions: QuestionReference[];
}

function object(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dataContainer(question: DecisionQuestionV2, path: DataPath): Record<string, JsonValue> {
  if (!object(question.instructions)) throw new Error("Question data requires object instructions");
  const value = path === "data" ? question.instructions : question.instructions.original;
  if (!object(value) || !Object.hasOwn(value, "data")) throw new Error("Question template data path is missing");
  return value;
}

/** Only identical question bodies share a template; per-question data retains its exact JSON value. */
export function templateDecisionBatchV2(batch: DecisionBatchV2): TemplatedDecisionBatchV2 {
  const { questions: source, ...scope } = batch;
  const questionTemplates: Record<string, QuestionTemplate> = {}, questions: QuestionReference[] = [];
  const templates = new Map<string, string>();
  for (const [id, sourceQuestion] of Object.entries(source)) {
    const question = structuredClone(sourceQuestion), instructions = question.instructions;
    const dataPath = object(instructions) && Object.hasOwn(instructions, "data") ? "data"
      : object(instructions) && object(instructions.original) && Object.hasOwn(instructions.original, "data") ? "original.data" : undefined;
    const container = dataPath ? dataContainer(question, dataPath) : undefined;
    const data = container?.data;
    // A placeholder preserves the original object's key order, including a null data value.
    if (container) container.data = null;
    const template: QuestionTemplate = { question, ...(dataPath ? { dataPath } : {}) };
    const key = JSON.stringify(template);
    let templateId = templates.get(key);
    if (templateId === undefined) {
      templateId = `t${templates.size}`;
      templates.set(key, templateId);
      questionTemplates[templateId] = template;
    }
    questions.push({ id, template: templateId, ...(dataPath ? { data: data! } : {}) });
  }
  return { ...scope, questionLayout: decisionQuestionLayout, questionTemplates, questions };
}

/** The inverse is available to exact-request inspection and transport fixtures. */
export function restoreDecisionBatchV2(encoded: TemplatedDecisionBatchV2): DecisionBatchV2 {
  const { questionLayout, questionTemplates, questions: references, ...scope } = encoded;
  if (questionLayout !== decisionQuestionLayout) throw new Error("Unknown decision question layout");
  const questions: Record<string, DecisionQuestionV2> = {};
  for (const reference of references) {
    const { id } = reference;
    const template = questionTemplates[reference.template];
    if (!template) throw new Error(`Missing decision question template: ${reference.template}`);
    const question = structuredClone(template.question);
    if (template.dataPath) {
      if (!Object.hasOwn(reference, "data")) throw new Error(`Missing decision question data: ${id}`);
      dataContainer(question, template.dataPath).data = structuredClone(reference.data!);
    } else if (Object.hasOwn(reference, "data")) throw new Error(`Unexpected decision question data: ${id}`);
    questions[id] = question;
  }
  return { ...scope, questions };
}
