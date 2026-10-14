import { z } from "zod";
import type { ModelExecutionAudit } from "../contracts/model";
import type { StructuredModelResult } from "../models/model-provider";
import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ActionExpression } from "./contracts";
import type { DirectDecisions } from "./decisions";
import type { ParticipantDiscourse } from "../contracts/discourse";

const actionFields = ["operation", "target", "recipient", "tool", "resource", "amount", "timing", "duration",
  "observation_scope", "capability", "progress_next", "search_location", "goal"];

/** A language reading binds dependent parameters and expression in one response. */
export async function readPlayerAction(input: { decisions: DirectDecisions; agentId: string; context: JsonValue;
  questions: Record<string, DecisionQuestionV2>; profileId: string; language: string; quotes: string[] }) {
  const { decisions, agentId, questions } = input;
  const catalog = Object.fromEntries(actionFields.flatMap(id => questions[id]?.type === "choice"
    ? [[id, questions[id].criteria]] : []));
  const cognition = Object.fromEntries(Object.entries(questions).filter(([id]) => /^(goal|belief)_status_/u.test(id)));
  const fieldShape = Object.fromEntries(Object.entries(catalog).map(([id, criteria]) => {
    const instructions = questions[id]?.instructions as { field?: string } | undefined;
    // Validate only the selected branch below. An unused field cannot veto speech.
    return [id, z.string().describe(`${instructions?.field ?? id} Allowed catalog keys: ${Object.keys(criteria).join(", ")}. Use none for an unused field.`).optional()];
  }));
  const system = loadPromptAsset("system/player-reading.md");
  const userPrompt = "Read the current input in the supplied conversation and return one coherent next interaction. Only catalog keys may identify entities or parameter choices.";
  const state = input.context as Record<string, JsonValue>;
  const { actionPolicy: _policy, actionKinds: _kinds, ...context } = state;
  void _policy; void _kinds;
  const discourse = state.discourse as unknown as ParticipantDiscourse | null;
  const presentedConversation = discourse?.exchanges.map(exchange => ({
    requestedByPlayer: exchange.requested, actuallyPresented: exchange.paragraphs.map(paragraph => paragraph.text),
  })) ?? [];
  const schema = z.object({
    understanding: z.string().describe("Briefly identify the intended interaction and next unperformed step. If there is a prerequisite, state whether actual evidence supports it or it remains unknown. Do not predict a result."),
    requestAnalysis: z.object({
      authorizedSteps: z.array(z.string()).describe("Only acts actually requested by THIS input, in order. Exclude quoted history, hypothetical branches not selected, other people's acts and added strategies."),
      establishedReceipts: z.array(z.string()).describe("Which requested steps have already executed in currentRequestReceipts, with their actual result. Empty for a fresh submission."),
      remainingSteps: z.array(z.string()).describe("Still unperformed authorized steps. A missing resource does not authorize obtaining or paying for it. Do not combine a physical transition and a later observation into one observation."),
    }).optional().describe("Diagnostic decomposition. Missing analysis does not invalidate a correctly bound executable interaction."),
    interaction: z.enum(["clarification", "world_action", "request_complete"]),
    action: z.object({ ...fieldShape, attempt: z.string(), utterance: z.string().nullable()
      .describe("The sole actual spoken text, or explicitly requested private reflection, for this step. No stage directions or unsolicited additions; null for a purely physical action or clarification."), manner: z.string().nullable(),
      literalQuote: z.enum(["none", "input", ...input.quotes.map((_, index) => `q${index}`)] as [string, ...string[]])
        .describe("input means EVERY WORD in the entire submitted input is literally spoken. Never choose input if ANY part describes a gesture, delivery, addressee, instruction to ask/say, or physical action. qN copies a quoted line. Otherwise choose none and supply only the intended utterance; requested delivery/gestures belong in manner.") }),
    cognition: z.record(z.string(), z.unknown()).optional(),
  });
  const audits: ModelExecutionAudit[] = [];
  let repair: { previousReading: unknown; issues: string[] } | null = null;
  let generated: StructuredModelResult<z.infer<typeof schema>>;
  for (;;) {
    try {
      generated = await decisions.provider.generateStructured({ ...decisions.scope, subjectId: agentId,
        modelRegistrySnapshotHash: decisions.control.registryHash, modelInvocation: decisions.next(agentId),
        profileId: input.profileId, role: "decision", schemaName: "PlayerActionReadingV4", system, userPrompt,
        promptVersion: `player-reading-${contentHash({ system, userPrompt })}`,
        context: { playerReading: { state: context, language: input.language, catalog, cognition, presentedConversation,
          exactQuotes: Object.fromEntries(input.quotes.map((quote, index) => [`q${index}`, quote])) },
          ...(repair ? { repair: { ...repair, instruction: "Correct only the reported executed-branch bindings against the same original request and catalog. Return the complete reading. Do not invent another action or alter the player's words." } } : {}) },
        schema, jsonExamplePolicy: "omit" });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      throw Object.assign(failure, { audits: [...audits, ...((failure as { audits?: ModelExecutionAudit[] }).audits ?? [])] });
    }
    audits.push(generated.audit);
    const previousReading = structuredClone(generated.value);
    const action = generated.value.action as Record<string, string | null>;
    const operation = action.operation;
    const issues: string[] = [];
    if (generated.value.interaction === "request_complete" &&
      (!Array.isArray(state.currentRequestReceipts) || state.currentRequestReceipts.length === 0)) {
      // A no-action reading of a fresh condition gets an explicit explanation,
      // never silent completion, a fabricated receipt or a transport-style error.
      if (operation === "none" && !action.utterance) generated.value.interaction = "clarification";
      else issues.push("Request completion requires a receipt from this submission; use clarification for a new input that requests no executable step");
    }
    const active = new Set(["operation", "timing", "duration", "progress_next", "goal",
      ...(["speak", "transfer"].includes(operation ?? "") ? ["recipient",
        ...(action.recipient === "discover" ? ["search_location"] : [])] : ["target"]),
      ...(operation === "observe" ? ["observation_scope"] : []),
      ...(["use", "change", "expand", "transfer"].includes(operation ?? "") ? ["tool", "resource", "capability",
        ...(action.resource && action.resource !== "none" ? ["amount"] : [])] : [])]);
    const defaults: Record<string, string> = { timing: "default", duration: "default", observation_scope: "target", amount: "unknown" };
    for (const [id, criteria] of Object.entries(catalog)) {
      if (!active.has(id)) { action[id] = defaults[id] ?? "none"; continue; }
      if (action[id] && Object.hasOwn(criteria, action[id]!)) continue;
      if (["timing", "duration", "amount"].includes(id) && (!action[id] || action[id] === "none")) {
        action[id] = defaults[id]!; continue;
      }
      if (active.has(id) && generated.value.interaction === "world_action") {
        issues.push(`Player reading did not bind the selected action's ${id}`);
      }
      action[id] = defaults[id] ?? "none";
    }

    if (!issues.length) break;
    if (repair) throw Object.assign(new Error(issues.join("; ")), { audits });
    repair = { previousReading, issues };
  }
  const action = generated.value.action as Record<string, string | null>;
  const operation = action.operation;
  const request = state.submittedAction as { rawText: string };
  if (operation === "speak" && action.literalQuote === "input") action.utterance = request.rawText;
  const answer = (choice: string): DecisionAnswerV2 => ({ type: "choice", choice, probabilities: null, confidence: null });
  const answers: Record<string, DecisionAnswerV2> = Object.fromEntries(Object.keys(catalog).map(id => [id, answer(action[id]!)]));
  for (const [id, question] of Object.entries(cognition)) {
    const value = generated.value.cognition?.[id];
    answers[id] = answer(typeof value === "string" && question.type === "choice" && Object.hasOwn(question.criteria, value) ? value : "unchanged");
  }
  answers.interaction = answer(generated.value.interaction);
  answers.speech = answer(action.utterance ? "create" : "none");
  answers.reflection = answer(action.utterance ? "create" : "none");
  const quote = ["none", "input"].includes(action.literalQuote ?? "none") ? null : input.quotes[Number(action.literalQuote!.slice(1))];
  let utterance = action.utterance?.trim() || null;
  if (utterance && quote) utterance = quote;
  // Copying the complete input does not authorize appending another player's reply.
  const verbatim = request.rawText.trim();
  const words = verbatim.replace(/[。！？.!?]+$/u, "");
  if (operation === "speak" && words && utterance?.startsWith(words)) utterance = verbatim;
  const expression: ActionExpression = { attempt: action.attempt!.trim(), utterance,
    manner: action.manner?.trim() || null };
  return { answers, expression, audits };
}
