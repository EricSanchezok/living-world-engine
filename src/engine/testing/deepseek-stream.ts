/** Provider boundary fixture using the documented final-choice usage frame. */
export function deepSeekStreamFixture(text = '{"answer":"行动自由 🐉"}', finishReason = "stop") {
  const usage = { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23,
    prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10,
    prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 0 } };
  const base = { id: "stream-response", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash" };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 12) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: text.slice(12) }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: { content: "" }, finish_reason: finishReason }], usage },
  ];
  const raw = ": keep-alive\r\n\r\n" + frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  return { raw, frames, usage };
}
