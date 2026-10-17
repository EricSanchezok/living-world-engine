import { z } from "zod";
import type { ModelExecutionAudit } from "../contracts/model";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "./model-audit";
import { ModelOutputError, NativeDecisionContextLimitError, type ModelExecutionScope, type StructuredModelProvider, type StructuredModelRequest } from "./model-provider";

const key = z.string().min(1).refine(value => !["__proto__", "constructor", "prototype"].includes(value));
const structured = z.custom<string | Record<string, JsonValue> | JsonValue[]>(value =>
  typeof value === "string" && value.trim().length > 0 || typeof value === "object" && value !== null);
const common = { version: z.string().min(1), instructions: structured, sources: z.array(z.string()).optional() };
export const decisionQuestionV2Schema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("choice"), criteria: z.record(key, structured.nullable())
    .refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255) }).strict(),
  z.object({ ...common, type: z.literal("noul"), criteria: z.object({ true: structured, false: structured }).strict().optional() }).strict(),
  z.object({ ...common, type: z.literal("score"), criteria: z.array(structured).min(2).max(10) }).strict(),
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const decisionBatchV2Schema = z.object({
  version: z.literal(2),
  view: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agentId: z.string().min(1), projectionHash: digest }).strict(),
    z.object({ kind: z.literal("world"), projectionHash: digest }).strict(),
  ]),
  dependencies: z.record(z.string().min(1), z.number().int().nonnegative().safe()),
  state: z.unknown(), questions: z.record(key, decisionQuestionV2Schema).refine(value => Object.keys(value).length > 0),
}).strict();
export type DecisionQuestionV2 = z.infer<typeof decisionQuestionV2Schema>;
export type DecisionBatchV2 = Omit<z.infer<typeof decisionBatchV2Schema>, "state"> & { state: JsonValue };
export type DecisionAnswerV2 =
  | { type: "choice"; choice: string; probabilities: Record<string, number> | null; confidence: number | null }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; legend: Record<string, unknown> | null; probabilities: Record<string, number> | null; confidence: number | null };
export interface DecisionResultV2 {
  version: 2; inputHash: string; answers: Record<string, DecisionAnswerV2>;
  audits: ModelExecutionAudit[];
  diagnostics: string[];
  dispatches: Array<{ questionIds: string[]; profileId: string; fallback: "context-limit" | null }>;
}
export type DecisionInstructionProfile = "publication";
export interface DecisionRequestV2 extends ModelExecutionScope {
  profileId: string; fallbackProfileId?: string; subjectId: string; batch: DecisionBatchV2;
  instructionProfile?: DecisionInstructionProfile;
  /** Applied only on language-model transports, including a native-context fallback. */
  inferenceOverrides?: StructuredModelRequest<unknown>["inferenceOverrides"];
  modelInvocation?: number; modelInvocationId?: string;
  allocateInvocation?: () => number;
}
export function validateDecisionBatchV2(input: unknown): DecisionBatchV2 {
  assertJsonValue(input, "decision batch v2");
  const batch = decisionBatchV2Schema.parse(input) as DecisionBatchV2;
  if (batch.view.projectionHash !== contentHash(batch.state)) throw new Error("decision projection hash mismatch");
  return frozenClone(batch);
}
export function decisionPromptV2(instructionProfile?: DecisionInstructionProfile) {
  const system = loadPromptAsset(instructionProfile === "publication" ? "system/narrative-publication.md"
    : "system/direct-decision.md"), userPrompt = loadPromptAsset("user/direct-decision.md");
  return { system, userPrompt, version: `decision-v2-${contentHash({ system, userPrompt })}` };
}
export function decisionWireContextV2(batch: DecisionBatchV2) {
  const policy = decisionPromptV2().system;
  return { state: batch.state, questions: Object.fromEntries(Object.entries(batch.questions).map(([id, question]) => [id, {
    type: question.type, instructions: { policy, task: question.instructions },
    ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
  }])) };
}
export function decisionOutputV2Schema(batch: DecisionBatchV2, native: boolean) {
  const probability = z.number().min(0).max(1);
  const distribution = (keys: string[]) => z.object(Object.fromEntries(keys.map(id => [id, probability]))).strict();
  return z.object({ answers: z.object(Object.fromEntries(Object.entries(batch.questions).map(([id, question]) => {
    if (!native) return [id, question.type === "choice" ? z.enum(Object.keys(question.criteria) as [string, ...string[]])
      : question.type === "noul" ? probability : z.number().min(0).max(question.criteria.length - 1)];
    if (question.type === "noul") return [id, z.object({ type: z.literal("noul"), noul: probability }).strict()];
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const fields = question.type === "choice"
      ? { type: z.literal("choice"), choice: z.enum(keys as [string, ...string[]]) }
      : { type: z.literal("score"), score: z.number().min(0).max(keys.length - 1) };
    return [id, z.object({ ...fields, ...(native ? {
      probabilities: distribution(keys), confidence: probability,
      ...(question.type === "score" ? { legend: z.object(Object.fromEntries(keys.map(key => [key, z.unknown()]))).strict() } : {}),
    } : {}) }).strict()];
  }))).strict() }).strict();
}
function diagnosticAnswers(answers: Record<string, DecisionAnswerV2>): string[] {
  return Object.entries(answers).flatMap(([id, answer]) => {
    if (answer.type === "noul" || !answer.probabilities) return [];
    const entries = Object.values(answer.probabilities), notes: string[] = [];
    if (Math.abs(entries.reduce((a, b) => a + b, 0) - 1) > 0.001) notes.push(`${id}: provider distribution is rounded or unnormalized`);
    if (answer.type === "choice" && answer.probabilities[answer.choice]! < Math.max(...entries)) notes.push(`${id}: provider choice differs from displayed probability maximum`);
    return notes;
  });
}
function nativeOverflow(error: unknown): boolean {
  return error instanceof NativeDecisionContextLimitError || error instanceof Error && error.cause !== error && nativeOverflow(error.cause);
}

/** A batch has one dependency-scoped state; an overflow cannot be fixed by repeating it per question. */
export async function executeDecisionV2(provider: StructuredModelProvider, request: DecisionRequestV2): Promise<DecisionResultV2> {
  const batch = validateDecisionBatchV2(request.batch), prompt = decisionPromptV2(request.instructionProfile);
  if (batch.view.kind === "agent" && batch.view.agentId !== request.subjectId) throw new Error("private decision subject must own its projection");
  const audits: ModelExecutionAudit[] = [], dispatches: DecisionResultV2["dispatches"] = [];
  let ordinal = request.modelInvocation ?? 1;
  const restore = (question: DecisionQuestionV2, raw: unknown): DecisionAnswerV2 => question.type === "choice"
    ? { type: "choice", choice: raw as string, probabilities: null, confidence: null }
    : question.type === "noul" ? { type: "noul", noul: raw as number }
    : { type: "score", score: raw as number, probabilities: null, confidence: null, legend: null };
  let repairUsed = false;
  const repairDiagnostics: string[] = [];
  const run = async (part: DecisionBatchV2, profileId: string, fallback: "context-limit" | null): Promise<Record<string, DecisionAnswerV2>> => {
    provider.catalog.assertProfile(profileId, "decision");
    const native = provider.catalog.account(provider.catalog.profile(profileId).account_id).protocol === "typesafe-systemone";
    dispatches.push({ questionIds: Object.keys(part.questions), profileId, fallback });
    try {
      const result = await provider.generateStructured({ ...request, modelInvocation: request.allocateInvocation?.() ?? ordinal++,
        // Each physical invocation receives a fresh gateway identity, including splits.
        modelInvocationId: undefined, profileId, role: "decision", schemaName: "DecisionBatchV2",
        inferenceOverrides: native ? undefined : request.inferenceOverrides,
        ...prompt, promptVersion: prompt.version, context: { decision: part }, schema: decisionOutputV2Schema(part, native), jsonExamplePolicy: "omit" });
      audits.push(result.audit);
      return Object.fromEntries(Object.entries(result.value.answers).map(([id, raw]) => {
        const question = part.questions[id]!;
        const answer: DecisionAnswerV2 = native ? raw as DecisionAnswerV2 : restore(question, raw);
        return [id, answer.type === "noul" ? answer : { ...answer,
          probabilities: native ? answer.probabilities : null, confidence: native ? answer.confidence : null,
          ...(answer.type === "score" ? { legend: native ? answer.legend : null } : {}) }];
      }));
    } catch (error) {
      const audit = (error as { audit?: ModelExecutionAudit })?.audit;
      if (audit) audits.push(audit);
      if (!native && error instanceof ModelOutputError && !repairUsed) {
        repairUsed = true;
        const raw = (error.rawValue as { answers?: Record<string, unknown> } | null)?.answers;
        const valid: Record<string, DecisionAnswerV2> = {}, invalid: Record<string, DecisionQuestionV2> = {};
        for (const [id, question] of Object.entries(part.questions)) {
          const parsed = decisionOutputV2Schema({ ...part, questions: { [id]: question } }, false).safeParse({ answers: { [id]: raw?.[id] } });
          if (parsed.success) valid[id] = restore(question, parsed.data.answers[id]);
          else invalid[id] = { ...question, instructions: { original: question.instructions,
            correction: "The preceding answer was absent, malformed or outside this question's allowed values. Choose an exact listed key or a number on the stated scale. Do not choose an entity key belonging only to another question.",
            rejectedAnswer: raw?.[id] as JsonValue ?? null } };
        }
        repairDiagnostics.push(`One format repair for: ${Object.keys(invalid).join(", ") || "unexpected extra fields"}`);
        if (!Object.keys(invalid).length) return valid;
        return { ...valid, ...await run({ ...part, questions: invalid }, profileId, fallback) };
      }
      if (!nativeOverflow(error) || !native) throw error;
      if (!request.fallbackProfileId || provider.catalog.account(provider.catalog.profile(request.fallbackProfileId).account_id).protocol === "typesafe-systemone") throw error;
      repairDiagnostics.push("Actual native context overflow: preserve the shared state and all questions in one fallback request");
      return run(part, request.fallbackProfileId, "context-limit");
    }
  };
  const answers = await run(batch, request.profileId, null);
  return { version: 2, inputHash: contentHash({ batch, profileId: request.profileId, catalogHash: provider.catalog.hash,
    registryHash: request.modelRegistrySnapshotHash ?? null, promptVersion: prompt.version,
    inferenceOverrides: request.inferenceOverrides ?? null }), answers, audits,
    diagnostics: [...diagnosticAnswers(answers), ...repairDiagnostics], dispatches };
}
