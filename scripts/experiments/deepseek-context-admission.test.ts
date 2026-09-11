import { expect, it } from "vitest";
import { assertDeepSeekContextWindow, assertDeepSeekTokenizerAsset, countDeepSeekContext, runLocalTokenCounter, DEEPSEEK_CONTEXT_WINDOW, DEEPSEEK_PROTOCOL_ALLOWANCE } from "./deepseek-context-admission";

it("admits the complete input plus unchanged output and protocol allowance, never byte count alone", () => {
  const output = 131072, atLimit = DEEPSEEK_CONTEXT_WINDOW - DEEPSEEK_PROTOCOL_ALLOWANCE - output;
  expect(assertDeepSeekContextWindow([0, atLimit], output).remainingTokens).toBe(0);
  expect(() => assertDeepSeekContextWindow([1, atLimit], output)).toThrow("no input or output limit was truncated");
  expect(() => assertDeepSeekContextWindow([1545, 925370], output)).toThrow("window 1048576");
  expect(assertDeepSeekContextWindow([1546, 870994], output).remainingTokens).toBeGreaterThan(0);
  for (const counts of [[-1, 0], [NaN, 0], [1], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    expect(() => assertDeepSeekContextWindow(counts, output)).toThrow();
  }
  expect(() => assertDeepSeekContextWindow([1, 1], 0)).toThrow();
  expect(() => assertDeepSeekTokenizerAsset(Buffer.from("different tokenizer"))).toThrow("fingerprint changed");
});

it("rejects uncounted request surfaces and changed inference before accessing tokenizer assets", async () => {
  const body = { model: "deepseek-v4-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" },
    max_tokens: 131072, messages: [{ role: "system", content: "rules" }, { role: "user", content: "task" }] };
  for (const changed of [{ tools: [] }, { thinking: { type: "enabled" } }, { model: "another-model" },
    { stream: true }, { stream_options: { include_usage: true } }, { stream: true, stream_options: { include_usage: false } },
    { messages: [...body.messages, { role: "tool", content: "unaccounted input" }] }]) {
    await expect(countDeepSeekContext({ ...body, ...changed })).rejects.toThrowError(expect.objectContaining({ name: "ZodError" }));
  }
});

it("drains a large input while other event-loop work continues and preserves each concurrent result", async () => {
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 10);
  const script = "let text=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', s=>text+=s); process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify(text)),50));";
  const messages = ["漢字".repeat(100000), "another input".repeat(10000)];
  const results = await Promise.all(messages.map(input => runLocalTokenCounter(process.execPath, ["-e", script], input)));
  clearTimeout(timer);
  expect(heartbeat).toBe(true);
  expect(results.map(result => JSON.parse(result))).toEqual(messages);
});

it("kills a stuck counter once and rejects without retrying or fabricating a count", async () => {
  await expect(runLocalTokenCounter(process.execPath, ["-e", "process.stdin.resume(); setInterval(()=>{},1000)"], "[]", 100))
    .rejects.toThrow("local tokenizer failed");
  await expect(runLocalTokenCounter(process.execPath, ["-e", "process.exit(7)"], "[]"))
    .rejects.toThrow("local tokenizer failed");
});
