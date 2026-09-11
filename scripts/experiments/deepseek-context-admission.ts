import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";

export const DEEPSEEK_TOKENIZER_SHA256 = "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf";
export const FLASH41_TOKENIZER_SHA256 = "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614";
export const DEEPSEEK_CONTEXT_WINDOW = 1048576, DEEPSEEK_PROTOCOL_ALLOWANCE = 1024;
const runtimeRoot = path.resolve(".livingworld-benchmarks/assets/deepseek-v4-flash-0731-tokenizer");
const positive = z.number().int().positive().safe();

export function assertDeepSeekContextWindow(messageTokens: number[], outputTokens: number) {
  z.array(z.number().int().nonnegative().safe()).length(2).parse(messageTokens); positive.parse(outputTokens);
  const inputContentTokens = messageTokens.reduce((sum, count) => sum + count, 0);
  const reservedContextTokens = inputContentTokens + DEEPSEEK_PROTOCOL_ALLOWANCE + outputTokens;
  if (!Number.isSafeInteger(reservedContextTokens) || reservedContextTokens > DEEPSEEK_CONTEXT_WINDOW) {
    throw new ModelConfigurationError(`complete context needs ${reservedContextTokens} tokens including ${DEEPSEEK_PROTOCOL_ALLOWANCE} protocol allowance; window ${DEEPSEEK_CONTEXT_WINDOW}; no input or output limit was truncated`);
  }
  return { messageTokens, inputContentTokens, protocolAllowance: DEEPSEEK_PROTOCOL_ALLOWANCE, outputTokens,
    reservedContextTokens, contextWindow: DEEPSEEK_CONTEXT_WINDOW, remainingTokens: DEEPSEEK_CONTEXT_WINDOW - reservedContextTokens };
}

export function assertDeepSeekTokenizerAsset(bytes: Buffer, expectedHash = DEEPSEEK_TOKENIZER_SHA256) {
  if (![DEEPSEEK_TOKENIZER_SHA256, FLASH41_TOKENIZER_SHA256].includes(expectedHash) ||
    createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw new ModelConfigurationError("public tokenizer asset fingerprint changed");
}

/** Drain both pipes asynchronously so admission cannot block other HTTP responses or stop timers. */
export function runLocalTokenCounter(executable: string, args: string[], input: string, timeout = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    let spawned = false, inputFlushed = false, stdoutBytes = 0;
    const child = execFile(executable, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout }, (error, stdout) => {
      if (error) reject(new ModelConfigurationError(`local tokenizer failed: ${error.message}; spawned=${spawned}; inputFlushed=${inputFlushed}; stdoutBytes=${stdoutBytes}`, { cause: error }));
      else resolve(stdout);
    });
    child.once("spawn", () => { spawned = true; });
    child.stdout?.on("data", chunk => { stdoutBytes += Buffer.byteLength(chunk); });
    child.stdin!.once("error", () => { /* execFile's exit/error callback owns process failure. */ });
    child.stdin!.end(input, () => { inputFlushed = true; });
  });
}

export async function countDeepSeekContext(body: unknown) {
  const request = z.strictObject({ model: z.enum(["deepseek-v4-flash", "deepseek-flash"]), thinking: z.strictObject({ type: z.literal("disabled") }),
    response_format: z.strictObject({ type: z.literal("json_object") }),
    stream: z.literal(true).optional(), stream_options: z.strictObject({ include_usage: z.literal(true) }).optional(),
    max_tokens: positive, messages: z.tuple([z.strictObject({ role: z.literal("system"), content: z.string() }),
      z.strictObject({ role: z.literal("user"), content: z.string() })]) })
    .refine(value => Boolean(value.stream) === Boolean(value.stream_options), "streaming requires explicit usage delivery").parse(body);
  const selectedRoot = request.model === "deepseek-flash" ? path.resolve(".livingworld-benchmarks/assets/deepseek-v4.1-flash-tokenizer") : runtimeRoot;
  const tokenizerSha256 = request.model === "deepseek-flash" ? FLASH41_TOKENIZER_SHA256 : DEEPSEEK_TOKENIZER_SHA256;
  const runtime = z.strictObject({ python: z.string().min(1) }).parse(JSON.parse(readFileSync(path.join(selectedRoot, "runtime.json"), "utf8")));
  const tokenizerPath = path.join(selectedRoot, "tokenizer.json"); assertDeepSeekTokenizerAsset(readFileSync(tokenizerPath), tokenizerSha256);
  const script = path.resolve("scripts/experiments/count-deepseek-tokens.py");
  const raw = await runLocalTokenCounter(runtime.python, [script, tokenizerPath], JSON.stringify(request.messages.map(message => message.content)));
  const count = z.strictObject({ version: z.literal("0.22.1"), messageTokens: z.array(z.number().int().nonnegative().safe()).length(2) }).parse(JSON.parse(raw));
  return { ...assertDeepSeekContextWindow(count.messageTokens, request.max_tokens), tokenizerSha256,
    runtimeVersion: count.version, counterHash: createHash("sha256").update(readFileSync(script)).digest("hex"), bodyHash: contentHash(body) };
}
