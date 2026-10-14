import { z } from "zod";
import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ActionExpression } from "./contracts";
import type { DirectDecisions } from "./decisions";

const actionFields = ["operation", "target", "recipient", "tool", "resource", "amount", "timing", "duration",
  "observation_scope", "capability", "progress_next", "search_location", "goal", "speech"];

/** A language reading binds dependent parameters and expression in one response. */
export async function readPlayerAction(input: { decisions: DirectDecisions; agentId: string; context: JsonValue;
  questions: Record<string, DecisionQuestionV2>; profileId: string; language: string; quotes: string[] }) {
  const { decisions, agentId, questions } = input;
  const catalog = Object.fromEntries(actionFields.flatMap(id => questions[id]?.type === "choice"
    ? [[id, id === "speech" ? Object.fromEntries(Object.entries(questions[id].criteria).filter(([key]) => !key.startsWith("span")))
      : questions[id].criteria]] : []));
  const cognition = Object.fromEntries(Object.entries(questions).filter(([id]) => /^(goal|belief)_status_/u.test(id)));
  const enumShape = Object.fromEntries(Object.entries(catalog).map(([id, criteria]) => {
    const instructions = questions[id]?.instructions as { field?: string } | undefined;
    return [id, z.enum([...new Set([...Object.keys(criteria), "none"])] as [string, ...string[]])
      .describe(instructions?.field ?? id).optional()];
  }));
  const system = loadPromptAsset("system/player-reading.md");
  const userPrompt = "Read the current input in the supplied conversation and return one coherent next interaction. Only catalog keys may identify entities or parameter choices.";
  const state = input.context as Record<string, JsonValue>;
  const { actionPolicy: _policy, actionKinds: _kinds, ...context } = state;
  void _policy; void _kinds;
  const schema = z.object({
    understanding: z.string().describe("Brief semantic summary of the requested interaction and the next unperformed step, not a predicted result."),
    interaction: z.enum(["clarification", "world_action"]),
    action: z.object({ ...enumShape, attempt: z.string(), utterance: z.string().nullable(), manner: z.string().nullable(),
      literalQuote: z.enum(["none", ...input.quotes.map((_, index) => `q${index}`)] as [string, ...string[]]) }),
    cognition: z.record(z.string(), z.unknown()).optional(),
  });
  const generated = await decisions.provider.generateStructured({ ...decisions.scope, subjectId: agentId,
    modelRegistrySnapshotHash: decisions.control.registryHash, modelInvocation: decisions.next(agentId),
    profileId: input.profileId, role: "decision", schemaName: "PlayerActionReadingV2", system, userPrompt,
    promptVersion: `player-reading-${contentHash({ system, userPrompt })}`,
    context: { playerReading: { state: context, language: input.language, catalog, cognition,
      exactQuotes: Object.fromEntries(input.quotes.map((quote, index) => [`q${index}`, quote])) } },
    schema, jsonExamplePolicy: "omit" });
  const action = generated.value.action as Record<string, string | null>;
  const operation = action.operation;
  const active = new Set(["operation", "timing", "duration", "progress_next", "goal",
    ...(["speak", "transfer"].includes(operation ?? "") ? ["recipient", "search_location"] : ["target"]),
    ...(operation === "observe" ? ["observation_scope"] : []),
    ...(["speak", "reflect"].includes(operation ?? "") ? ["speech"] : []),
    ...(["use", "change", "expand", "transfer"].includes(operation ?? "") ? ["tool", "resource", "capability",
      ...(action.resource && action.resource !== "none" ? ["amount"] : [])] : [])]);
  const defaults: Record<string, string> = { timing: "default", duration: "default", observation_scope: "target", amount: "unknown" };
  for (const [id, criteria] of Object.entries(catalog)) {
    if (action[id] && Object.hasOwn(criteria, action[id]!)) continue;
    if (["timing", "duration", "amount"].includes(id) && (!action[id] || action[id] === "none")) {
      action[id] = defaults[id]!; continue;
    }
    if (active.has(id) && generated.value.interaction !== "clarification") {
      throw Object.assign(new Error(`Player reading did not bind the selected action's ${id}`), { audit: generated.audit });
    }
    action[id] = defaults[id] ?? "none";
  }
  const answer = (choice: string): DecisionAnswerV2 => ({ type: "choice", choice, probabilities: null, confidence: null });
  const answers: Record<string, DecisionAnswerV2> = Object.fromEntries(Object.keys(catalog).map(id => [id, answer(action[id]!)]));
  for (const [id, question] of Object.entries(cognition)) {
    const value = generated.value.cognition?.[id];
    answers[id] = answer(typeof value === "string" && question.type === "choice" && Object.hasOwn(question.criteria, value) ? value : "unchanged");
  }
  answers.interaction = answer(generated.value.interaction);
  answers.speech = answer(action.speech ?? (action.utterance ? "create" : "none"));
  answers.reflection = answer(action.utterance ? "create" : "none");
  const quote = action.literalQuote === "none" ? null : input.quotes[Number(action.literalQuote!.slice(1))];
  const request = state.submittedAction as { rawText: string };
  const speechChoice = action.speech;
  const literal = speechChoice === "input" ? request.rawText : /^q\d+$/u.test(speechChoice ?? "") ? input.quotes[Number(speechChoice!.slice(1))]
    : null;
  const expression: ActionExpression = { attempt: action.attempt!.trim(), utterance: quote ?? (operation === "speak" ? literal : null) ?? action.utterance?.trim() ?? null,
    manner: action.manner?.trim() || null };
  return { answers, expression, audit: generated.audit };
}
