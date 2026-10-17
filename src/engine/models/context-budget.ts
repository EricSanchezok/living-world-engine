import type { ResolvedModelBinding } from "./model-registry";
import { decisionWireContextV2, type DecisionBatchV2 } from "./decision-v2";
import type { MemoryPressure } from "../cognition/memory";

/** Conservative multilingual estimate, not a provider tokenizer or an exact token count. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text.match(/[A-Za-z0-9_]+|\s+|[^\s]/gu) ?? []).reduce((sum, part) => sum +
    (/^[A-Za-z0-9_]+$/u.test(part) ? Math.ceil(part.length / 3) : /^\s+$/u.test(part) ? Math.ceil(part.length / 4)
      : part.codePointAt(0)! > 127 ? 2 : 1), 0);
}

export function requestPressure(binding: ResolvedModelBinding, context: unknown,
  prompt: { system: string; userMessage: string; schemaJson: string; requestUtf8Bytes: number }, calibration = 1): MemoryPressure {
  const native = binding.account.protocol === "typesafe-systemone";
  const capacity = binding.model.limit.context ?? Infinity;
  const inputLimit = Math.min(binding.profile.max_input_tokens ?? Infinity,
    native ? capacity : Math.max(1, capacity - binding.profile.max_output_tokens));
  let input = estimateTokens([prompt.system, prompt.userMessage, prompt.schemaJson]) + 128;
  let question = 0;
  if (native) {
    const wire = decisionWireContextV2((context as { decision: DecisionBatchV2 }).decision);
    input = estimateTokens(wire) + 128;
    question = estimateTokens(wire.state) + Math.max(...Object.values(wire.questions).map(value => estimateTokens(value))) + 128;
  }
  const estimatedInputTokens = Math.ceil(input * calibration), estimatedQuestionTokens = Math.ceil(question * calibration);
  const questionLimit = binding.profile.max_question_tokens;
  return { estimatedInputTokens, inputLimit,
    ...(native && questionLimit ? { estimatedQuestionTokens, questionLimit } : {}),
    ratio: Math.max(estimatedInputTokens / inputLimit,
      native && questionLimit ? estimatedQuestionTokens / questionLimit : 0,
      prompt.requestUtf8Bytes / binding.profile.max_input_bytes) };
}
