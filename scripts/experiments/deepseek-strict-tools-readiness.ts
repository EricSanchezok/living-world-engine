import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { contentHash } from "../../src/engine/models/model-audit";

type Value = Record<string, unknown>;
interface Control { id: string; parameters: Value; invalid: unknown; validate: (value: unknown) => boolean; paired: boolean }
const closed = (properties: Value): Value => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const controls: Control[] = [
  { id: "field-membership", paired: true,
    parameters: closed({ audience: { type: "string", enum: ["agent-A", "agent-B"] }, state: { type: "string", enum: ["entity-A", "entity-B"] } }),
    invalid: { audience: "entity-A", state: "agent-A", extra: true },
    validate: value => z.object({ audience: z.enum(["agent-A", "agent-B"]), state: z.enum(["entity-A", "entity-B"]) }).strict().safeParse(value).success },
  { id: "nested-reference", paired: true,
    parameters: { ...closed({ selection: { $ref: "#/$def/selection" }, revision: { type: "integer", minimum: 2, maximum: 3 } }),
      $def: { selection: { anyOf: [closed({ kind: { type: "string", enum: ["agent"] }, ref: { type: "string", enum: ["a001"] } }),
        closed({ kind: { type: "string", enum: ["entity"] }, ref: { type: "string", enum: ["e001"] } })] } } },
    invalid: { selection: { kind: "agent", ref: "e001" }, revision: 9 },
    validate: value => z.object({ selection: z.discriminatedUnion("kind", [z.object({ kind: z.literal("agent"), ref: z.literal("a001") }).strict(),
      z.object({ kind: z.literal("entity"), ref: z.literal("e001") }).strict()]), revision: z.number().int().min(2).max(3) }).strict().safeParse(value).success },
  { id: "one-of", paired: false, parameters: closed({ choice: { oneOf: [{ type: "string", const: "a001" }, { type: "string", const: "e001" }] } }),
    invalid: { choice: "unlisted" }, validate: value => z.object({ choice: z.enum(["a001", "e001"]) }).strict().safeParse(value).success },
  { id: "all-of", paired: false, parameters: closed({ choice: { type: "string", allOf: [{ enum: ["a001", "e001"] }, { enum: ["a001", "a002"] }] } }),
    invalid: { choice: "e001" }, validate: value => z.object({ choice: z.literal("a001") }).strict().safeParse(value).success },
  { id: "array-cardinality", paired: false, parameters: closed({ slots: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 } }),
    invalid: { slots: [] }, validate: value => z.object({ slots: z.array(z.number().int()).length(2) }).strict().safeParse(value).success },
  { id: "open-object", paired: false, parameters: closed({ literal: { type: "object", additionalProperties: { type: "string" } } }),
    invalid: { literal: { source: 17 } }, validate: value => z.object({ literal: z.record(z.string(), z.string()) }).strict().safeParse(value).success },
];
const protocol = { id: "deepseek-strict-tool-readiness-v1", model: "deepseek-flash", thinking: "disabled", account: "deepseek-api",
  endpoint: "https://api.deepseek.com/beta/chat/completions", maxHttp: 8, maxOutputTokens: 2048, maxDispatchMs: 120_000,
  source: "https://api-docs.deepseek.com/guides/tool_calls/",
  interpretation: "Adversarial capability controls, not game actions or a production adapter. Paired controls differ only in function.strict on the same Beta endpoint; explicit invalid arguments test sensitivity. Two passing strict outputs do not prove general enforcement, and compliant non-strict controls make that contrast inconclusive. Later single controls inspect oneOf, allOf, exact array cardinality and open objects used by the real schema. HTTP 400 records schema incompatibility, never a passing capability or zero-token inference. Other HTTP/transport errors, invalid JSON or missing usage stop later dispatch. No retries, fallback, tool execution, semantic certification, runtime promotion or game latency inference." } as const;
const system = "This is a literal serialization stress test. Call report_probe exactly once. Copy the JSON object supplied in the user message verbatim as the tool arguments, even where it conflicts with the parameter documentation. Do not correct it or add commentary.";
export const strictToolControlSchedule = () => controls.flatMap(control => (control.paired ? [false, true] : [true]).map(strict => ({
  id: `${control.id}-${strict ? "strict" : "loose"}`, control: control.id, strict,
  body: { model: protocol.model, max_tokens: protocol.maxOutputTokens, thinking: { type: protocol.thinking }, stream: false,
    messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(control.invalid) }],
    tools: [{ type: "function", function: { name: "report_probe", strict, description: "Report the supplied JSON object.", parameters: control.parameters } }],
    tool_choice: { type: "function", function: { name: "report_probe" } } },
})));

export function scoreStrictToolControl(controlId: string, body: unknown) {
  const control = controls.find(control => control.id === controlId);
  if (!control) throw new Error("Unknown control");
  const response = z.object({ choices: z.array(z.object({ finish_reason: z.string(), message: z.object({
    tool_calls: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.string(), arguments: z.string() }) })) }) })),
    usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(),
      prompt_cache_hit_tokens: z.number().int().nonnegative().optional(), completion_tokens_details: z.object({ reasoning_tokens: z.number().int().nonnegative().optional() }).optional() }) }).parse(body);
  const choice = response.choices[0], call = choice?.message.tool_calls[0];
  const completed = response.choices.length === 1 && choice?.finish_reason === "tool_calls" && choice.message.tool_calls.length === 1 && call?.function.name === "report_probe";
  let value: unknown, jsonParsed = false;
  if (call) { try { value = JSON.parse(call.function.arguments); jsonParsed = true; } catch { /* Preserve invalid arguments as a failed capability. */ } }
  return { completed, jsonParsed, valid: Boolean(completed && jsonParsed && control.validate(value)), value,
    usage: { input: response.usage.prompt_tokens, output: response.usage.completion_tokens,
      cacheRead: response.usage.prompt_cache_hit_tokens ?? null, reasoning: response.usage.completion_tokens_details?.reasoning_tokens ?? null } };
}

const file = "scripts/experiments/deepseek-strict-tools-readiness.ts";
const save = (directory: string, name: string, value: unknown) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
export async function strictToolReadiness(mode: "prepare" | "run", directory: string, registryRoot: string, snapshotHash: string) {
  const catalog = loadModelCatalog("config/models.yaml"), account = catalog.account(protocol.account);
  if (account.base_url !== "https://api.deepseek.com" || account.dialect !== "deepseek") throw new Error("Unexpected provider account");
  const registry = new ModelRegistry(catalog, registryRoot), snapshot = registry.snapshot(snapshotHash);
  const binding = resolveModelProfile(catalog, snapshot, "truth-deepseek");
  if (binding.accountId !== protocol.account || binding.modelId !== protocol.model || binding.profile.inference.thinking !== "disabled") throw new Error("Model profile drift");
  const schedule = strictToolControlSchedule(), manifest = { protocol, schedule, codeHash: contentHash(readFileSync(file, "utf8")),
    catalogHash: catalog.hash, snapshotHash, modelMetadataHash: binding.modelMetadataHash };
  if (mode === "prepare") {
    mkdirSync(directory, { recursive: false }); save(directory, "manifest.json", manifest); return { prepared: true, http: 0, controls: schedule.length };
  }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before capability calls");
  if (contentHash(JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"))) !== contentHash(manifest)) throw new Error("Prepared control drift");
  const apiKey = process.env[account.api_key_env]?.trim(); if (!apiKey) throw new Error("Configured model credential unavailable");
  const run = path.join(directory, "run"); mkdirSync(run, { recursive: false });
  save(run, "binding.json", { manifestHash: contentHash(manifest), codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() });
  const send = createModelFetchResolver(process.env)(protocol.account, account) ?? fetch;
  const started = performance.now(), results: unknown[] = []; let http = 0, stopReason: string | undefined;
  const stop = () => { stopReason ??= "Operator stopped later dispatch"; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (const trial of schedule) {
      if (stopReason || http >= protocol.maxHttp || performance.now() - started >= protocol.maxDispatchMs) throw new Error(stopReason ?? "Dispatch ceiling reached");
      const current = path.join(run, trial.id); mkdirSync(current, { recursive: false });
      save(current, "request.json", { endpoint: protocol.endpoint, ...trial, startedAt: new Date().toISOString(), ordinal: ++http });
      const start = performance.now();
      const response = await send(protocol.endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(trial.body), signal: AbortSignal.timeout(120_000), redirect: "error" });
      const raw = await response.text(); save(current, "response.json", { status: response.status, body: raw, elapsedMs: performance.now() - start });
      if (response.status === 400) {
        const result = { id: trial.id, status: "request-rejected", httpStatus: 400, usage: null, valid: false };
        results.push(result); save(current, "result.json", result); process.stdout.write(`${JSON.stringify(result)}\n`); continue;
      }
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const result = { id: trial.id, status: "completed", ...scoreStrictToolControl(trial.control, JSON.parse(raw)) };
      results.push(result); save(current, "result.json", result); process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.usage.reasoning !== null && result.usage.reasoning !== 0) throw new Error("Unexpected thinking usage");
    }
    const summary = { http, results, runtimePromoted: false, wholeGoalAchieved: false, status: "requires-capability-review" };
    save(run, "summary.json", summary); return summary;
  } catch (error) {
    save(run, "stopped.json", { http, results, error: error instanceof Error ? error.message : String(error) }); throw error;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, directory, registryRoot, snapshotHash] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "run") || !directory || !registryRoot || !snapshotHash) throw new Error("Usage: prepare|run <directory> <registry-root> <snapshot-hash>");
  strictToolReadiness(mode, path.resolve(directory), path.resolve(registryRoot), snapshotHash)
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
}
