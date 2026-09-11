import { createParser } from "eventsource-parser";
import { z } from "zod";

export const DEEPSEEK_JSON_STREAM = "deepseek-sse-v1";
const count = z.number().int().nonnegative();
const usageSchema = z.looseObject({
  prompt_tokens: count, completion_tokens: count, total_tokens: count,
  prompt_cache_hit_tokens: count, prompt_cache_miss_tokens: count,
  prompt_tokens_details: z.looseObject({ cached_tokens: count }).optional(),
  completion_tokens_details: z.looseObject({ reasoning_tokens: count.optional() }).optional(),
});
const chunkSchema = z.looseObject({
  id: z.string().min(1), model: z.string().min(1), object: z.literal("chat.completion.chunk"),
  choices: z.array(z.strictObject({
    index: z.literal(0),
    delta: z.strictObject({ role: z.enum(["assistant", ""]).optional(), content: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional() }),
    finish_reason: z.string().nullable(),
    logprobs: z.unknown().optional(),
  })).length(1),
  usage: usageSchema.nullable().optional(),
});

/** Validate complete native frames before the SDK or ledger accepts a response.
 * Framing follows https://api-docs.deepseek.com/api/create-chat-completion/ . */
export function completeDeepSeekJsonStream(raw: string, expectedModel?: string) {
  let identity: { id: string; model: string } | undefined;
  let done = false;
  let finishReason: string | undefined;
  let usage: z.infer<typeof usageSchema> | undefined;
  const content: string[] = [], reasoning: string[] = [];
  const parser = createParser({
    onError(error) { throw error; },
    onEvent(event) {
      if (done) throw new Error("DeepSeek stream contains data after DONE");
      if (event.data === "[DONE]") { done = true; return; }
      if (finishReason !== undefined) throw new Error("DeepSeek stream contains data after finish");
      const frame = chunkSchema.parse(JSON.parse(event.data));
      if (expectedModel !== undefined && frame.model !== expectedModel) throw new Error("DeepSeek stream model differs from request");
      if (identity && (identity.id !== frame.id || identity.model !== frame.model)) {
        throw new Error("DeepSeek stream response identity changed");
      }
      identity ??= { id: frame.id, model: frame.model };
      const choice = frame.choices[0]!;
      if (choice.delta.content != null) content.push(choice.delta.content);
      if (choice.delta.reasoning_content != null) reasoning.push(choice.delta.reasoning_content);
      if (frame.usage != null) {
        if (choice.finish_reason === null || usage) throw new Error("DeepSeek stream usage is not terminal");
        usage = frame.usage;
      }
      if (choice.finish_reason !== null) finishReason = choice.finish_reason;
    },
  });
  parser.feed(raw);
  if (!done || !identity || !finishReason || !usage ||
    !/(?:^|[\r\n])data: ?\[DONE\](?:\r\n|\r|\n)(?:\r\n|\r|\n)[ \t\r\n]*$/u.test(raw)) {
    throw new Error("DeepSeek stream missing complete termination or usage");
  }
  if (usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens ||
    usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens !== usage.prompt_tokens ||
    (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens !== usage.prompt_cache_hit_tokens)) {
    throw new Error("DeepSeek stream usage totals do not reconcile");
  }
  return { ...identity, usage, choices: [{ index: 0, finish_reason: finishReason,
    message: { role: "assistant" as const, content: content.join(""), reasoning_content: reasoning.join("") } }] };
}
