import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { ModelGateway } from "../../model-gateway";
import { parseModelCatalog } from "../../model-catalog";
import { FairModelScheduler } from "../../model-scheduler";
import { decisionOutputV2Schema, decisionPromptV2, validateDecisionBatchV2 } from "../../decision-v2";
import { contentHash } from "../../model-audit";
import { summarizeModelExecutionAudit, type StructuredModelRequest } from "../../model-provider";
import { createTestModelRegistry } from "../../../testing/model-provider";
import { deepSeekStreamFixture } from "../../../testing/deepseek-stream";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type AdapterKind = "deepseek-sse" | "deepseek-json" | "typesafe";
type Scenario = "timeout" | "caller-abort" | "success";
function errorNames(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  return [error.name, ...errorNames(error.cause)];
}

async function run(kind: AdapterKind, scenario: Scenario) {
  assert.equal(typeof global.gc, "function", "Run this probe in a child with --expose-gc");
  const sockets = new Set<Socket>(), signals: AbortSignal[] = [];
  const fixture = deepSeekStreamFixture('{"answer":"fixture"}');
  const chat = { id: "chat-fixture", object: "chat.completion", created: 0, model: "deepseek-v4-flash",
    choices: [{ index: 0, message: { role: "assistant", content: '{"answer":"fixture"}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } };
  const native = { model: "jev-fixture", answers: { present: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 10, output_tokens: 1 } };
  let sends = 0, firstResponseClosed = false;
  let firstSocket: Socket | undefined;
  const server = createServer((request, response) => {
    request.resume();
    sends++;
    if (sends === 1) { firstSocket = request.socket; response.on("close", () => { firstResponseClosed = true; }); }
    response.writeHead(200, { "content-type": kind === "deepseek-sse" ? "text/event-stream" : "application/json" });
    response.flushHeaders();
    if (sends === 1 && scenario !== "success") {
      response.write(kind === "deepseek-sse" ? ": keep-alive\n\n" : " ");
      return;
    }
    response.end(kind === "deepseek-sse" ? fixture.raw : JSON.stringify(kind === "typesafe" ? native : chat));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const catalog = parseModelCatalog({ schema_version: 3,
    scheduler: { global_concurrency: 1, max_queued_requests: 4, queue_timeout_ms: 5000 },
    registry: { refresh_interval_ms: 3600000, request_timeout_ms: 1000, stale_after_ms: 86400000 },
    accounts: { fixture: { channel: "api", region: "test", protocol: kind !== "typesafe" ? "openai-chat" : "typesafe-systemone",
      dialect: kind !== "typesafe" ? "deepseek" : "typesafe", models_dev_provider_id: "fixture",
      base_url: `http://127.0.0.1:${address.port}`, api_key_env: "FIXTURE_KEY", max_concurrency: 1 } },
    profiles: { probe: { account_id: "fixture", selector: { kind: "exact", model_id: kind !== "typesafe" ? "deepseek-v4-flash" : "jev-fixture" },
      description: "Local transport deadline fixture", ...(kind === "deepseek-sse" ? { response_transport: "deepseek-sse-v1" } : {}),
      allowed_roles: ["agent-mind", "decision"], request_timeout_ms: 1000, max_output_tokens: 1000, inference: {} } }, model_overrides: {} });
  const scheduler = new FairModelScheduler({ globalConcurrency: 1, maxQueuedRequests: 4, queueTimeoutMs: 5000, providerConcurrency: { fixture: 1 } });
  const gateway = new ModelGateway(catalog, { FIXTURE_KEY: "fixture-only" }, {
    registry: createTestModelRegistry(catalog), scheduler, maxTransportAttempts: scenario === "caller-abort" ? 3 : 1,
    fetch: (input, init) => { assert(init?.signal); signals.push(init.signal); return fetch(input, init); },
  });
  const caller = new AbortController();
  const state = { fixture: true };
  const batch = validateDecisionBatchV2({ version: 2, view: { kind: "world", projectionHash: contentHash(state) },
    dependencies: { fixture: 1 }, state, questions: { present: { type: "noul", version: "1", instructions: "Controlled fixture probability." } } });
  const prompt = decisionPromptV2();
  const request = (n: number): StructuredModelRequest<unknown> => ({ profileId: "probe", workloadId: "fixture", batchId: `case-${n}`,
    subjectId: "world", runtimeIdentity: { worldHash: `sha256:${"0".repeat(64)}`, revision: 0 },
    ...(n === 1 ? { abortSignal: caller.signal } : {}),
    ...(kind !== "typesafe" ? { role: "agent-mind" as const, promptVersion: "fixture-v1", schemaName: "answer_output",
      system: "Return fixture JSON.", userPrompt: "Return fixture JSON.", context: { fixture: n }, schema: z.strictObject({ answer: z.string() }) } :
      { role: "decision" as const, promptVersion: prompt.version, schemaName: "DecisionBatchV2", system: prompt.system,
        userPrompt: prompt.userPrompt, context: { decision: batch }, schema: decisionOutputV2Schema(batch, true) }) });
  const started = performance.now();
  const gcTimer = setInterval(() => global.gc!(), 25);
  const first = gateway.generateStructured(request(1)).then(value => ({ value }), error => ({ error: error as unknown }));
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome;
  try {
    await sleep(40);
    const second = gateway.generateStructured(request(2));
    if (scenario === "caller-abort") abortTimer = setTimeout(() => caller.abort(new DOMException("fixture caller abort", "AbortError")), 80);
    outcome = await Promise.race([Promise.all([first, second]), new Promise<null>(resolve => { watchdogTimer = setTimeout(() => resolve(null), 2500); })]);
    clearTimeout(watchdogTimer);
    assert(outcome, `${kind} ${scenario}: request remained active after its deadline; permit=${scheduler.activeCount}, queued=${scheduler.queuedCount}`);
    const [firstResult, secondResult] = outcome;
    if (scenario === "success") assert("value" in firstResult);
    else {
      assert("error" in firstResult);
      assert(errorNames(firstResult.error).includes(scenario === "timeout" ? "TimeoutError" : "AbortError"));
    }
    const settledMs = Math.round(performance.now() - started);
    await sleep(20);
    assert.equal(firstResponseClosed, true, "The stalled HTTP response must be closed before accepting settlement");
    if (scenario !== "success") assert.equal(firstSocket?.destroyed, true, "Aborted HTTP must not leave its socket hanging");
    assert.equal(scheduler.activeCount, 0);
    assert.equal(scheduler.queuedCount, 0);
    assert.equal(sends, 2, "Caller cancellation must not retry and the queued request must execute");
    const usage = summarizeModelExecutionAudit(secondResult.audit).tokenUsage;
    assert.equal(usage.input, kind !== "typesafe" ? 20 : 10);
    assert.equal(usage.output, kind !== "typesafe" ? 3 : 1);
    await sleep(1050);
    caller.abort(new DOMException("after settlement", "AbortError"));
    assert.equal(signals[1]!.aborted, false, "The successful request deadline must be cleared");
    if (scenario === "success") assert.equal(signals[0]!.aborted, false, "A settled request must detach caller cancellation");
    return { kind, scenario, settledMs, active: scheduler.activeCount, queued: scheduler.queuedCount, sends, usage,
      firstResponseClosed, abortedSocketDestroyed: scenario === "success" ? null : firstSocket?.destroyed,
      firstErrorNames: "error" in firstResult ? errorNames(firstResult.error) : [] };
  } finally {
    clearInterval(gcTimer);
    clearTimeout(abortTimer);
    clearTimeout(watchdogTimer);
    caller.abort(new DOMException("fixture cleanup", "AbortError"));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function main() {
  const results = [];
  const kinds: AdapterKind[] = process.argv[2] ? [z.enum(["deepseek-sse", "deepseek-json", "typesafe"]).parse(process.argv[2])] : ["deepseek-sse", "deepseek-json", "typesafe"];
  for (const kind of kinds) {
    for (const scenario of ["timeout", "caller-abort", "success"] as const) results.push(await run(kind, scenario));
  }
  console.log(JSON.stringify({ node: process.version, results }));
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
