import type { ResolvedModelBinding } from "./model-registry";
import { decisionWireContextV2, type DecisionBatchV2 } from "./decision-v2";
import type { MemoryPressure } from "../cognition/memory";

/** Rolling upper envelope, ordered by dispatch rather than response arrival. */
export class TokenCalibration {
  private sequence = 0;
  private samples = new Map<string, Array<{ sequence: number; ratio: number }>>();
  next() { return ++this.sequence; }
  factor(key: string): number {
    const samples = this.samples.get(key) ?? [];
    if (!samples.length) return 1;
    const upper = Math.max(...samples.map(sample => sample.ratio)) * 1.1;
    return samples.length < 3 ? Math.max(1, upper) : upper;
  }
  observe(key: string, sequence: number, estimated: number, actual: number | null) {
    if (!actual || !Number.isFinite(actual) || actual < 0 || estimated < 1024) return;
    const samples = (this.samples.get(key) ?? []).filter(sample => sample.sequence !== sequence);
    samples.push({ sequence, ratio: actual / estimated });
    this.samples.set(key, samples.sort((a, b) => b.sequence - a.sequence).slice(0, 32));
  }
}

/** Language shifts must not borrow a cheaper tokenizer ratio from unrelated requests. */
export function tokenLanguageBand(text: string): number {
  let nonAscii = 0;
  for (const char of text) if (char.codePointAt(0)! > 127) nonAscii++;
  return Math.min(3, Math.floor(nonAscii / Math.max(1, text.length) * 4));
}

/** Conservative multilingual estimate, not a provider tokenizer or an exact token count. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text.match(/[A-Za-z0-9_]+|\s+|[^\s]/gu) ?? []).reduce((sum, part) => sum +
    (/^[A-Za-z0-9_]+$/u.test(part) ? Math.ceil(part.length / 3) : /^\s+$/u.test(part) ? Math.ceil(part.length / 4)
      : part.codePointAt(0)! > 127 ? 2 : 1), 0);
}

export function requestPressure(binding: ResolvedModelBinding, context: unknown,
  prompt: { system: string; userMessage: string; schemaJson: string; requestUtf8Bytes: number }, calibration = 1): MemoryPressure & {
    uncalibratedInputTokens: number; calibration: number; requestUtf8Bytes: number;
  } {
  const native = binding.account.protocol === "typesafe-systemone";
  const capacity = binding.model.limit.context ?? Infinity;
  const inputLimit = Math.min(binding.profile.max_input_tokens ?? Infinity,
    native ? capacity : Math.max(1, capacity - binding.profile.max_output_tokens));
  let input = estimateTokens([prompt.system, prompt.userMessage, prompt.schemaJson]) + 128;
  let question = 0;
  let requestUtf8Bytes = prompt.requestUtf8Bytes;
  if (native) {
    const wire = decisionWireContextV2((context as { decision: DecisionBatchV2 }).decision);
    input = estimateTokens(wire) + 128;
    question = estimateTokens(wire.state) + Math.max(...Object.values(wire.questions).map(value => estimateTokens(value))) + 128;
    requestUtf8Bytes = Buffer.byteLength(JSON.stringify({ model: binding.modelId, ...wire }), "utf8");
  }
  // Both are estimates of the same tokenizer, not exact per-question provider counts.
  const estimatedInputTokens = Math.ceil(input * calibration), estimatedQuestionTokens = Math.ceil(question * calibration);
  const questionLimit = binding.profile.max_question_tokens;
  return { estimatedInputTokens, inputLimit, uncalibratedInputTokens: input, calibration, requestUtf8Bytes,
    ...(native && questionLimit ? { estimatedQuestionTokens, questionLimit } : {}),
    ratio: Math.max(estimatedInputTokens / inputLimit,
      native && questionLimit ? estimatedQuestionTokens / questionLimit : 0,
      requestUtf8Bytes / binding.profile.max_input_bytes) };
}
