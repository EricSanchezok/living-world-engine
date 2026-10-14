import { z } from "zod";
import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ActionExpression } from "./contracts";
import type { DirectDecisions } from "./decisions";

const actionFields = ["operation", "target", "recipient", "tool", "resource", "amount", "timing", "duration",
  "observation_scope", "capability", "progress_next", "search_location", "goal"];

/** A language reading binds dependent parameters and expression in one response. */
export async function readPlayerAction(input: { decisions: DirectDecisions; agentId: string; context: JsonValue;
  questions: Record<string, DecisionQuestionV2>; profileId: string; language: string; quotes: string[] }) {
  const { decisions, agentId, questions } = input;
  const catalog = Object.fromEntries(actionFields.flatMap(id => questions[id]?.type === "choice"
    ? [[id, questions[id].criteria]] : []));
  const cognition = Object.fromEntries(Object.entries(questions).filter(([id]) => /^(goal|belief)_status_/u.test(id)));
  const enumShape = (fields: Record<string, Record<string, unknown>>) => Object.fromEntries(Object.entries(fields)
    .map(([id, criteria]) => [id, z.enum(Object.keys(criteria) as [string, ...string[]])]));
  const cognitiveCatalog = Object.fromEntries(Object.entries(cognition).flatMap(([id, question]) => question.type === "choice" ? [[id, question.criteria]] : []));
  const system = loadPromptAsset("system/player-reading.md");
  const userPrompt = "Read the current input in the supplied conversation and return one coherent next interaction. Only catalog keys may identify entities or parameter choices.";
  const state = input.context as Record<string, JsonValue>;
  const { actionPolicy: _policy, actionKinds: _kinds, ...context } = state;
  void _policy; void _kinds;
  const schema = z.object({
    understanding: z.string().describe("Brief semantic summary of the requested interaction and the next unperformed step, not a predicted result."),
    interaction: z.enum(["clarification", "world_action"]),
    action: z.object({ ...enumShape(catalog), attempt: z.string(), utterance: z.string().nullable(), manner: z.string().nullable(),
      literalQuote: z.enum(["none", ...input.quotes.map((_, index) => `q${index}`)] as [string, ...string[]]) }),
    cognition: z.object(enumShape(cognitiveCatalog)),
  });
  const generated = await decisions.provider.generateStructured({ ...decisions.scope, subjectId: agentId,
    modelRegistrySnapshotHash: decisions.control.registryHash, modelInvocation: decisions.next(agentId),
    profileId: input.profileId, role: "decision", schemaName: "PlayerActionReadingV1", system, userPrompt,
    promptVersion: `player-reading-${contentHash({ system, userPrompt })}`,
    context: { playerReading: { state: context, language: input.language, catalog, cognition,
      exactQuotes: Object.fromEntries(input.quotes.map((quote, index) => [`q${index}`, quote])) } },
    schema, jsonExamplePolicy: "omit" });
  const action = generated.value.action as Record<string, string | null>;
  const answer = (choice: string): DecisionAnswerV2 => ({ type: "choice", choice, probabilities: null, confidence: null });
  const answers: Record<string, DecisionAnswerV2> = Object.fromEntries(Object.keys(catalog).map(id => [id, answer(action[id]!)]));
  for (const [id, value] of Object.entries(generated.value.cognition)) answers[id] = answer(value);
  answers.interaction = answer(generated.value.interaction);
  answers.speech = answer(action.utterance ? "create" : "none");
  answers.reflection = answer(action.utterance ? "create" : "none");
  const quote = action.literalQuote === "none" ? null : input.quotes[Number(action.literalQuote!.slice(1))];
  const expression: ActionExpression = { attempt: action.attempt!.trim(), utterance: quote ?? action.utterance?.trim() ?? null,
    manner: action.manner?.trim() || null };
  return { answers, expression, audit: generated.audit };
}
