import { z } from "zod";
import type { ModelExecutionAudit } from "../contracts/model";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "./model-audit";
import { ContextLimitExceededError, type ModelExecutionScope, type StructuredModelProvider } from "./model-provider";

export const DECISION_CONTRACT_VERSION = 1;
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).refine(
  value => !["constructor", "prototype", "__proto__"].includes(value), "unsafe decision key",
);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const questionSchema = z.object({
  version: z.string().min(1),
  instructions: z.string().min(1),
  criteria: z.record(key, z.string().min(1)).refine(
    value => Object.keys(value).length >= 2 && Object.keys(value).length <= 255,
    "a decision requires between 2 and 255 explicit criteria",
  ),
  sources: z.array(z.string().min(1)).min(1),
}).strict();

export const decisionBatchSchema = z.object({
  version: z.literal(DECISION_CONTRACT_VERSION),
  view: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agentId: z.string().min(1), projectionHash: hash }).strict(),
    z.object({ kind: z.literal("world"), projectionHash: hash }).strict(),
  ]),
  programHash: hash,
  dependencies: z.record(z.string().min(1), z.number().int().nonnegative().safe()),
  state: z.unknown(),
  questions: z.record(key, questionSchema).refine(value => Object.keys(value).length > 0, "empty decision batch"),
}).strict();

export type DecisionBatch = Omit<z.infer<typeof decisionBatchSchema>, "state"> & { state: JsonValue };
export interface DecisionAnswer {
  choice: string;
  /** Native provider distributions only; generative comparison arms report null. */
  probabilities: Record<string, number> | null;
  confidence: number | null;
}
export interface DecisionResult {
  version: 1;
  inputHash: string;
  programHash: string;
  view: DecisionBatch["view"];
  dependencies: DecisionBatch["dependencies"];
  questions: DecisionBatch["questions"];
  answers: Record<string, DecisionAnswer>;
  audit: ModelExecutionAudit;
  fallback: null | { fromProfileId: string; reason: "context-limit"; detail: string };
}
export interface DecisionRequest extends ModelExecutionScope {
  profileId: string;
  fallbackProfileId?: string;
  subjectId: string;
  batch: DecisionBatch;
  modelInvocationId?: string;
  modelInvocation?: number;
}

export function validateDecisionBatch(input: unknown): DecisionBatch {
  assertJsonValue(input, "decision batch");
  const batch = decisionBatchSchema.parse(input);
  assertJsonValue(batch.state, "decision state");
  if (batch.view.projectionHash !== contentHash(batch.state)) throw new Error("decision projection hash mismatch");
  return frozenClone(batch as DecisionBatch);
}

export function decisionOutputSchema(batch: DecisionBatch, native: boolean) {
  return z.object({ answers: z.object(Object.fromEntries(Object.entries(batch.questions).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    const choice = z.enum(choices as [string, ...string[]]);
    return [id, native
      ? z.object({ type: z.literal("choice"), choice,
          probabilities: z.object(Object.fromEntries(choices.map(option => [option, z.number().min(0).max(1)]))).strict()
            .refine(value => Math.abs(Object.values(value).reduce((sum, probability) => sum + probability, 0) - 1) <= 0.001,
              "probabilities must sum to one"),
          confidence: z.number().min(0).max(1),
        }).strict()
      : z.object({ choice }).strict()];
  }))).strict() }).strict();
}

export function decisionPrompt() {
  const system = loadPromptAsset("system/decision.md");
  const userPrompt = loadPromptAsset("user/decision.md");
  return { system, userPrompt, version: `decision-${contentHash({ system, userPrompt, version: DECISION_CONTRACT_VERSION })}` };
}

/** Native transport carries this same complete semantic contract on every independent question. */
export function decisionWireContext(batch: DecisionBatch) {
  const prompt = decisionPrompt();
  return {
    state: batch.state,
    questions: Object.fromEntries(Object.entries(batch.questions).map(([id, question]) => [id, {
      type: "choice" as const,
      instructions: `${prompt.system}\n\n${question.instructions}`,
      criteria: question.criteria,
    }])),
  };
}

export async function executeDecision(provider: StructuredModelProvider, request: DecisionRequest): Promise<DecisionResult> {
  const batch = validateDecisionBatch(request.batch);
  if (batch.view.kind === "agent" && batch.view.agentId !== request.subjectId) {
    throw new Error("private decision subject must own its authorized projection");
  }
  const prompt = decisionPrompt();
  const inputHash = contentHash({ batch, promptVersion: prompt.version });
  const execute = async (profileId: string, fallback: DecisionResult["fallback"]): Promise<DecisionResult> => {
    provider.catalog.assertProfile(profileId, "decision");
    const profile = provider.catalog.profile(profileId);
    const native = provider.catalog.account(profile.account_id).protocol === "typesafe-systemone";
    const result = await provider.generateStructured({
      ...request, profileId, role: "decision", schemaName: "DecisionBatchV1",
      system: prompt.system, userPrompt: prompt.userPrompt, promptVersion: prompt.version,
      context: { decision: batch }, schema: decisionOutputSchema(batch, native), jsonExamplePolicy: "omit",
    });
    const answers = Object.fromEntries(Object.entries(result.value.answers).map(([id, answer]) => [id, {
      choice: answer.choice,
      probabilities: "probabilities" in answer ? answer.probabilities as Record<string, number> : null,
      confidence: "confidence" in answer ? answer.confidence as number : null,
    }]));
    return { version: 1, inputHash, programHash: batch.programHash, view: batch.view,
      dependencies: batch.dependencies, questions: batch.questions, answers, audit: result.audit, fallback };
  };
  try { return await execute(request.profileId, null); }
  catch (error) {
    if (!(error instanceof ContextLimitExceededError) || !request.fallbackProfileId ||
      provider.catalog.account(provider.catalog.profile(request.profileId).account_id).protocol !== "typesafe-systemone") throw error;
    if (provider.catalog.account(provider.catalog.profile(request.fallbackProfileId).account_id).protocol === "typesafe-systemone") {
      throw new Error("decision context fallback must use a generative profile");
    }
    return execute(request.fallbackProfileId, {
      fromProfileId: request.profileId, reason: "context-limit", detail: error.message,
    });
  }
}
