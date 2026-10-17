import { z } from "zod";
import type { ModelExecutionAudit } from "../contracts/model";
import { ModelOutputError, type StructuredModelResult } from "../models/model-provider";
import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ActionExpression } from "./contracts";
import type { DirectDecisions } from "./decisions";

const actionFields = ["operation", "target", "recipient", "tool", "resource", "amount", "timing", "duration",
  "observation_scope", "capability", "progress_next", "search_location", "goal", "reflection_duration"];

/** A language reading binds dependent parameters and expression in one response. */
export async function readAction(input: { decisions: DirectDecisions; agentId: string; context: JsonValue;
  questions: Record<string, DecisionQuestionV2>; profileId: string; language: string; quotes: string[]; autonomous?: boolean }) {
  const { decisions, agentId, questions } = input;
  const autonomous = input.autonomous === true;
  const catalog = Object.fromEntries(actionFields.flatMap(id => questions[id]?.type === "choice"
    ? [[id, questions[id].criteria]] : []));
  const cognition = Object.fromEntries(Object.entries(questions).filter(([id]) => /^(goal|belief)_status_/u.test(id)));
  const fieldShape = Object.fromEntries(Object.entries(catalog).map(([id, criteria]) => {
    const instructions = questions[id]?.instructions as { field?: string } | undefined;
    // Validate only the selected branch below. An unused field cannot veto speech.
    return [id, z.string().nullable().describe(`${instructions?.field ?? id} Allowed catalog keys: ${Object.keys(criteria).join(", ")}. Use none for an unused field.`).optional()];
  }));
  const system = loadPromptAsset(autonomous ? "system/autonomous-action.md" : "system/player-reading.md");
  const userPrompt = autonomous
    ? "Choose this character's next coherent attempt, or a motivated wait, from their private situation. Bind its goal, method, listener and actual words together. Only catalog keys may identify entities or parameter choices."
    : "Read the current input in the supplied conversation and return one coherent next interaction. Only catalog keys may identify entities or parameter choices.";
  const state = input.context as Record<string, JsonValue>;
  const { actionPolicy: _policy, actionKinds: _kinds, ...context } = state;
  void _policy; void _kinds;
  const schema = z.object({
    understanding: z.string().describe(autonomous
      ? "One brief statement of this attempt's purpose or the actual reason to wait. Name the uncertainty an inspection addresses. No private reasoning transcript or predicted success."
      : "Briefly identify the intended interaction and next unperformed step. If there is a prerequisite, state whether actual evidence supports it or it remains unknown. Do not predict a result."),
    ...(autonomous ? { urgency: z.number().min(0).max(1).describe("Urgency of this actual attempt: 0 can wait, 1 immediate danger or deadline.") } : {}),
    ...(autonomous ? {} : {
      conversationReading: z.object({
        addressedTo: z.enum(["narrator", "character", "no_speech"]),
        meaningInContext: z.string().describe("The full meaning of THIS input in the current thread. For an ellipsis, preserve the previous question and replace only the new subject/scope. Resolve the same item even when the player's premise about possession is false."),
      }).optional(),
      requestAnalysis: z.object({
        authorizedSteps: z.array(z.string()).describe("Only acts actually requested by THIS input, in order. Exclude quoted history, hypothetical branches not selected, other people's acts and added strategies."),
        establishedReceipts: z.array(z.string()).describe("Which requested steps have already executed in currentRequestReceipts, with their actual result. Empty for a fresh submission."),
        remainingSteps: z.array(z.string()).describe("Still unperformed authorized steps. A missing resource does not authorize obtaining or paying for it. Do not combine a physical transition and a later observation into one observation."),
      }).optional().describe("Diagnostic decomposition. Missing analysis does not invalidate a correctly bound executable interaction."),
    }),
    interaction: autonomous ? z.literal("world_action") : z.enum(["clarification", "world_action", "request_complete"]),
    action: z.object({ ...fieldShape, attempt: z.string(), utterance: z.string().nullable()
      .describe(autonomous ? "Actual words addressed to the selected listener, or private synthesis for reflect; null for silent activity or wait. Speech is a proposal, not proof of delivery or agreement."
        : "The sole actual spoken text, or explicitly requested private reflection, for this step. No stage directions or unsolicited additions; null for a purely physical action or clarification."), manner: z.string().nullable(),
      literalQuote: z.enum(["none", "input", ...input.quotes.map((_, index) => `q${index}`)] as [string, ...string[]])
        .describe(autonomous ? "Always none: this character authors their own words."
          : "input means EVERY WORD in the entire submitted input is literally spoken. Never choose input if ANY part describes a gesture, delivery, addressee, instruction to ask/say, or physical action. qN copies a quoted line. Otherwise choose none and supply only the intended utterance; requested delivery/gestures belong in manner.") }),
    cognition: z.record(z.string(), z.unknown()).optional(),
  });
  const audits: ModelExecutionAudit[] = [];
  let repair: { previousReading: unknown; issues: string[] } | null = null;
  let generated: StructuredModelResult<z.infer<typeof schema>>;
  for (;;) {
    try {
      generated = await decisions.provider.generateStructured({ ...decisions.scope, subjectId: agentId,
        modelRegistrySnapshotHash: decisions.control.registryHash, modelInvocation: decisions.next(agentId),
        profileId: input.profileId, role: autonomous ? "creation" : "decision", schemaName: autonomous ? "AutonomousActionReadingV1" : "PlayerActionReadingV4", system, userPrompt,
        promptVersion: `${autonomous ? "autonomous-action" : "player-reading"}-${contentHash({ system, userPrompt })}`,
        context: { [autonomous ? "autonomousReading" : "playerReading"]: { state: context, language: input.language, catalog, cognition,
          exactQuotes: Object.fromEntries(input.quotes.map((quote, index) => [`q${index}`, quote])) },
          ...(repair ? { repair: { ...repair, instruction: autonomous
            ? "Resolve the reported contradictions as one complete intention using this same private situation and catalog. A deliberate wait must have a situational reason; missing speech parameters do not by themselves justify waiting. Do not claim any attempt succeeded."
            : "Correct only the reported executed-branch bindings against the same original request and catalog. Return the complete reading. Do not invent another action or alter the player's words." } } : {}) },
        schema, jsonExamplePolicy: "omit" });
    } catch (error) {
      if (error instanceof ModelOutputError && !repair) {
        if (error.audit) audits.push(error.audit);
        repair = { previousReading: error.rawValue ?? null, issues: [error.message] };
        continue;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      // The failing invocation remains on failure.audit; the runtime collects
      // it separately. This array contains preceding attempts only.
      throw Object.assign(failure, { audits: [...audits, ...((failure as { audits?: ModelExecutionAudit[] }).audits ?? [])] });
    }
    audits.push(generated.audit);
    const previousReading = structuredClone(generated.value);
    const action = generated.value.action as Record<string, string | null>;
    const operation = action.operation;
    const issues: string[] = [];
    if (autonomous) {
      if (!action.attempt?.trim()) issues.push("Supply the concrete attempted behavior, or the situation being awaited.");
      if (action.literalQuote !== "none") issues.push("An autonomous character has no player input to quote; author the actual utterance and select literalQuote=none.");
      if (operation === "speak" && (!action.recipient || action.recipient === "none" || !action.utterance?.trim())) {
        issues.push("Speech needs both actual words and their listener (an observed local identity, broadcast, or discover for a genuinely unlocated listener). Bind them to the same communicative purpose.");
      }
      if (operation === "observe" && action.observation_scope === "target" && (!action.target || action.target === "none")) {
        issues.push("A targeted inspection needs its local target. A survey of this scene uses observation_scope=surroundings.");
      }
      if (operation === "wait" && action.utterance?.trim()) issues.push("Waiting is silent. Words that actually address someone select speak with their listener.");
    }
    if (generated.value.interaction === "world_action" && operation === "move" &&
      (!action.target || action.target === "none")) {
      issues.push("A move needs its actual destination: select the current_location catalog entry for movement within this place. If the destination is genuinely unknown, select only a search actually authorized by the request. Do not silently replace a local movement with discovery.");
    }
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
      ...(operation === "reflect" ? ["reflection_duration"] : []),
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
        issues.push(`Action reading did not bind the selected action's ${id}`);
      }
      action[id] = defaults[id] ?? "none";
    }

    if (!issues.length) break;
    if (repair) throw Object.assign(new Error(issues.join("; ")), { audits });
    repair = { previousReading, issues };
  }
  const action = generated.value.action as Record<string, string | null>;
  const operation = action.operation;
  const request = state.submittedAction as { rawText: string } | null;
  if (request && operation === "speak" && action.literalQuote === "input") action.utterance = request.rawText;
  const answer = (choice: string): DecisionAnswerV2 => ({ type: "choice", choice, probabilities: null, confidence: null });
  const answers: Record<string, DecisionAnswerV2> = Object.fromEntries(Object.keys(catalog).map(id => [id, answer(action[id]!)]));
  for (const [id, question] of Object.entries(cognition)) {
    const value = generated.value.cognition?.[id];
    answers[id] = answer(typeof value === "string" && question.type === "choice" && Object.hasOwn(question.criteria, value) ? value : "unchanged");
  }
  answers.interaction = answer(generated.value.interaction);
  answers.speech = answer(action.utterance ? "create" : "none");
  answers.reflection = answer(action.utterance ? "create" : "none");
  if (autonomous) answers.urgency = { type: "score", score: generated.value.urgency as number, probabilities: null, confidence: null, legend: null };
  const quote = ["none", "input"].includes(action.literalQuote ?? "none") ? null : input.quotes[Number(action.literalQuote!.slice(1))];
  let utterance = action.utterance?.trim() || null;
  if (utterance && quote) utterance = quote;
  // Copying the complete input does not authorize appending another player's reply.
  const verbatim = request?.rawText.trim() ?? "";
  const words = verbatim.replace(/[。！？.!?]+$/u, "");
  if (operation === "speak" && words && utterance?.startsWith(words)) utterance = verbatim;
  const expression: ActionExpression = { attempt: action.attempt!.trim(), utterance,
    manner: action.manner?.trim() || null };
  return { answers, expression, audits };
}
