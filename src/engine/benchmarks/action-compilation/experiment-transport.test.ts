import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperimentBudget } from "./experiment-budget";
import { FirstPassExperimentTransport } from "./experiment-transport";
import { immutableExperimentJson, lockExperiment } from "./experiment-artifacts";
import { AC_FP3_BUDGET } from "./semantic-first-pass-protocol";
import { deepSeekStreamFixture } from "../../testing/deepseek-stream";
import { FLASH41_COHORT, FLASH41_PRICE, STEP_E2_BUDGET } from "../step-efficiency/nonthinking-protocol";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(delegate: typeof fetch, requireThinkingDisabled = false, streamed = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ac-fp1-http-"));
  roots.push(root);
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"));
  const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: "https://test.invalid", inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, fetch: delegate, requireThinkingDisabled,
    ...(streamed ? { responseTransport: "deepseek-sse-v1" } : {}) });
  transport.beginTrial("discovery-P01-00-A", "discovery");
  return { root, budget, transport };
}
const request = (streamed = false) => new Request("https://test.invalid/chat/completions", { method: "POST", headers: { authorization: "Bearer test-credential-never-record" }, body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072, messages: [], ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}) }) });
const response = () => Response.json({ usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10 } });

describe("AC-FP1 actual HTTP boundary", () => {
  it.each(["ok", "response-model", "request-model", "thinking"])("binds registered model prices and preserves strict non-thinking response identity: %s", async kind => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cohort-transport-")); roots.push(root);
    const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    budget.registerModelPrice({ priceId: FLASH41_COHORT.priceId, price: FLASH41_PRICE,
      reason: "Verified provider retirement and replacement model price", evidenceHash: "a".repeat(64) });
    let calls = 0;
    const raw = deepSeekStreamFixture().raw.replaceAll("deepseek-v4-flash", kind === "response-model" ? "unexpected-model" : FLASH41_COHORT.model);
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, requireThinkingDisabled: true,
      responseTransport: "deepseek-sse-v1", priceBinding: { accountId: "deepseek-api", modelId: FLASH41_COHORT.model, priceId: FLASH41_COHORT.priceId },
      fetch: async () => { calls++; return new Response(raw, { headers: { "content-type": "text/event-stream" } }); } });
    transport.beginTrial("discovery-P01-00-A", "discovery");
    const send = () => transport.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify({
      model: kind === "request-model" ? "deepseek-v4-flash" : FLASH41_COHORT.model,
      thinking: { type: kind === "thinking" ? "enabled" : "disabled" }, max_tokens: 131_072,
      stream: true, stream_options: { include_usage: true },
    }) });
    if (kind === "ok") expect(await (await send()).text()).toBe(raw);
    else await expect(send()).rejects.toThrow(kind === "response-model" ? "model differs from request"
      : kind === "request-model" ? "actual HTTP model" : "thinking must be explicitly disabled");
    expect(calls).toBe(kind === "ok" || kind === "response-model" ? 1 : 0);
    expect(budget.summary.phases.discovery.knownTokens).toBe(kind === "ok" ? 23 : 0);
    expect(budget.summary.blockingUnknown).toHaveLength(kind === "response-model" ? 1 : 0);
    if (kind === "ok") expect(budget.summary.estimatedPeakNanoCny).toBe(10 * 2000 + 10 * 40 + 3 * 8000);
  });

  it.each(["complete", "missing-done", "reasoning"])("accounts for native streamed delivery without accepting partial usage: %s", async kind => {
    const test = setup(async () => response());
    let calls = 0;
    const fixture = deepSeekStreamFixture();
    const raw = kind === "missing-done" ? fixture.raw.replace("data: [DONE]\r\n\r\n", "")
      : kind === "reasoning" ? fixture.raw.replace('"reasoning_tokens":0', '"reasoning_tokens":1') : fixture.raw;
    const transport = new FirstPassExperimentTransport(test.budget, { root: test.root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, requireThinkingDisabled: true,
      responseTransport: "deepseek-sse-v1", fetch: async () => {
        calls++; return new Response(raw, { headers: { "content-type": "text/event-stream" } });
      } });
    transport.beginTrial("discovery-P01-00-A", "discovery");
    const body = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072,
      thinking: { type: "disabled" }, stream: true, stream_options: { include_usage: true } });
    const send = () => transport.fetch("https://test.invalid/chat/completions", { method: "POST", body });
    if (kind === "complete") expect(await (await send()).text()).toBe(raw);
    else {
      await expect(send()).rejects.toThrow();
      await expect(send()).rejects.toThrow();
    }
    expect(calls).toBe(1);
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(kind === "missing-done" ? 0 : 23);
    expect(test.budget.summary.blockingUnknown).toHaveLength(kind === "missing-done" ? 1 : 0);
    const stored = JSON.parse(readFileSync(path.join(test.root, "http", "discovery-P01-00-A-http-001", "response.json"), "utf8"));
    expect(stored.raw).toBe(raw);
  });

  it("rejects missing usage opt-in before streaming reservation", async () => {
    const test = setup(async () => response());
    const transport = new FirstPassExperimentTransport(test.budget, { root: test.root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, responseTransport: "deepseek-sse-v1",
      fetch: async () => { throw new Error("must not send"); } });
    transport.beginTrial("discovery-P01-00-A", "discovery");
    await expect(transport.fetch("https://test.invalid/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072, stream: true }) })).rejects.toThrow("drift");
    expect(test.budget.summary.unsettled).toEqual([]);
  });
  it.each([false, true])("preserves bytes after a real peer socket closure and retains the full hold (stream=%s)", async streamed => {
    const prefix = Buffer.from((streamed ? "data: " : "  ") + '{"choices":["行动');
    const partial = prefix.subarray(0, prefix.length - 1);
    let closePeer!: () => void;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": streamed ? "text/event-stream" : "application/json" });
      response.write(partial);
      closePeer = () => response.socket!.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    let returnedHeaders!: () => void;
    const headers = new Promise<void>((resolve) => { returnedHeaders = resolve; });
    let calls = 0;
    const test = setup(async (_input, init) => {
      calls++;
      const result = await fetch(`http://127.0.0.1:${address.port}`, init);
      returnedHeaders();
      return result;
    }, false, streamed);
    try {
      const pending = expect(test.transport.fetch(request(streamed))).rejects.toThrow();
      await headers;
      // Let the real fetch body deliver its first chunk before the peer closes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const held = test.budget.summary.reservedNanoCny;
      closePeer();
      await pending;
      const directory = path.join(test.root, "http", "discovery-P01-00-A-http-001");
      const failure = JSON.parse(readFileSync(path.join(directory, "response-failure.json"), "utf8"));
      expect(failure).toMatchObject({ stage: "response-body", complete: false, aborted: false,
        receivedBytes: partial.length, partialBase64: partial.toString("base64"),
        error: { cause: { code: "UND_ERR_SOCKET" } } });
      expect(JSON.parse(readFileSync(path.join(directory, "response-start.json"), "utf8"))).toMatchObject({ status: 200 });
      expect(existsSync(path.join(directory, "response.json"))).toBe(false);
      expect(test.budget.summary.reservedNanoCny).toBe(held);
      expect(test.budget.summary.phases.discovery.knownTokens).toBe(0);
      expect(test.budget.summary.blockingUnknown).toHaveLength(1);
      await expect(test.transport.fetch(request())).rejects.toThrow();
      expect(calls).toBe(1);
      expect(readFileSync(path.join(directory, "response-failure.json"), "utf8")).not.toContain("test-credential");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("distinguishes failure before headers from an interrupted body", async () => {
    const test = setup(async () => { throw new TypeError("connection failed"); });
    await expect(test.transport.fetch(request())).rejects.toThrow("connection failed");
    const directory = path.join(test.root, "http", "discovery-P01-00-A-http-001");
    expect(JSON.parse(readFileSync(path.join(directory, "response-failure.json"), "utf8")))
      .toMatchObject({ stage: "before-response-headers", receivedBytes: 0, partialBase64: "", headersElapsedMs: null });
    expect(existsSync(path.join(directory, "response-start.json"))).toBe(false);
  });

  it("retains the complete raw JSON and returns the original response bytes", async () => {
    const raw = '\ufeff  ' + JSON.stringify({ text: "行动自由", usage: { prompt_tokens: 20, completion_tokens: 3,
      total_tokens: 23, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10 } });
    const source = new Response(raw);
    const test = setup(async () => source);
    const returned = await test.transport.fetch(request());
    expect(returned).toBe(source);
    expect(Buffer.from(await returned.arrayBuffer())).toEqual(Buffer.from(raw));
    const directory = path.join(test.root, "http", "discovery-P01-00-A-http-001");
    expect(JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8")).raw).toBe(raw.slice(1));
    expect(existsSync(path.join(directory, "response-failure.json"))).toBe(false);
    expect(test.budget.summary.unsettled).toEqual([]);
  });

  it("preserves an explicit provider rejection without fabricating usage or retrying", async () => {
    let calls = 0;
    const message = "maximum context length is1048576; requested1058011 tokens";
    const test = setup(async () => { calls++; return Response.json({ error: { message } }, { status: 400 }); });
    await expect(test.transport.fetch(request())).rejects.toThrow(`provider HTTP 400: ${message}`);
    expect(test.budget.summary.unknown).toHaveLength(1);
    expect(test.budget.summary.reservedNanoCny).toBeGreaterThan(0);
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(0);
    const stored = JSON.parse(readFileSync(path.join(test.root, "http", "discovery-P01-00-A-http-001", "response.json"), "utf8"));
    expect(stored.status).toBe(400);
    expect(JSON.parse(stored.raw).error.message).toBe(message);
    await expect(test.transport.fetch(request())).rejects.toThrow(message);
    expect(calls).toBe(1);
  });
  it.each([
    {},
    { thinking: { type: "enabled" }, reasoning_effort: "low" },
    { thinking: { type: "disabled" }, reasoning_effort: "low" },
    { thinking: { type: "disabled" }, reasoning: { effort: "high" } },
  ])("blocks non-thinking protocol drift before any reservation or HTTP: %j", async (controls) => {
    let calls = 0;
    const test = setup(async () => { calls++; return response(); }, true);
    await expect(test.transport.fetch("https://test.invalid/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072, ...controls }),
    })).rejects.toThrow("thinking must be explicitly disabled");
    expect(calls).toBe(0);
    expect(test.budget.summary.phases.discovery.httpRequests).toBe(0);
    expect(test.budget.summary.unsettled).toEqual([]);
  });

  it("sends explicit disabled thinking and retains the actual controls in evidence", async () => {
    let calls = 0;
    const test = setup(async (input, init) => {
      const body = await new Request(input, init).json();
      expect(body.thinking).toEqual({ type: "disabled" });
      calls++;
      return response();
    }, true);
    await test.transport.fetch("https://test.invalid/chat/completions", { method: "POST",
      body: JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072, thinking: { type: "disabled" } }),
    });
    expect(calls).toBe(1);
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(23);
    const stored = JSON.parse(readFileSync(path.join(test.root, "http", "discovery-P01-00-A-http-001", "request.json"), "utf8"));
    expect(stored.body.thinking).toEqual({ type: "disabled" });
  });

  it.each([
    { choices: [{ message: { reasoning_content: "Unexpected provider reasoning" } }] },
    { usageDetails: { reasoning_tokens: 1 } },
  ])("retains reliable incurred usage before stopping on reported reasoning: %j", async (extra) => {
    let calls = 0;
    const test = setup(async () => {
      calls++;
      return Response.json({ ...extra,
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23,
          prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10,
          completion_tokens_details: extra.usageDetails },
      });
    }, true);
    const body = JSON.stringify({ model: "deepseek-v4-flash", max_tokens: 131_072, thinking: { type: "disabled" } });
    await expect(test.transport.fetch("https://test.invalid/chat/completions", { method: "POST", body }))
      .rejects.toThrow("incurred usage retained");
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(23);
    expect(test.budget.summary.estimatedPeakNanoCny).toBeGreaterThan(0);
    expect(test.budget.summary.unknown).toEqual([]);
    await expect(test.transport.fetch("https://test.invalid/chat/completions", { method: "POST", body })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("retains real provider concurrency and drains sibling usage after an unknown response", async () => {
    const test = setup(async () => response());
    const policy = { ...test.budget.policy, maxConcurrentRequests: 2 };
    const budget = new ExperimentBudget(path.join(test.root, "concurrent.jsonl"), policy);
    let active = 0;
    let peak = 0;
    let calls = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const started = new Promise<void>((resolve) => { reached = resolve; });
    const transport = new FirstPassExperimentTransport(budget, { root: test.root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, scheduling: "provider",
      fetch: async () => {
        const ordinal = ++calls;
        peak = Math.max(peak, ++active);
        if (active === 2) reached();
        await barrier;
        active -= 1;
        if (ordinal === 1) throw new TypeError("unknown transport completion");
        return response();
      },
    });
    transport.beginTrial("discovery-P01-00-A", "discovery");
    const pending = Promise.allSettled([transport.fetch(request()), transport.fetch(request())]);
    await started;
    expect(budget.summary.inFlight).toHaveLength(2);
    expect(budget.summary.reservedNanoCny).toBeGreaterThan(0);
    release();
    const results = await pending;
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(peak).toBe(2);
    expect(budget.summary.unknown).toHaveLength(1);
    expect(budget.summary.inFlight).toHaveLength(0);
    expect(budget.summary.phases.discovery.knownTokens).toBe(23);
    await expect(transport.fetch(request())).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("does not reserve or send an already cancelled request", async () => {
    let calls = 0;
    const test = setup(async () => { calls++; return response(); });
    const controller = new AbortController();
    controller.abort();
    await expect(test.transport.fetch(request(), { signal: controller.signal })).rejects.toThrow();
    expect(test.budget.summary.phases.discovery.httpRequests).toBe(0);
    expect(test.budget.summary.unsettled).toEqual([]);
    expect(calls).toBe(0);
  });

  it("charges the actual pinned Pro request and rejects using a Flash price", async () => {
    const test = setup(async () => response());
    const budget = new ExperimentBudget(path.join(test.root, "v3.jsonl"), AC_FP3_BUDGET);
    let calls = 0;
    const options = { root: test.root, baseUrl: "https://test.invalid", inputTokenCeiling: 100, outputTokenCeiling: 16384,
      trialPattern: /^calibration-[a-z]+$/u, fetch: async () => { calls++; return response(); } };
    const pro = new FirstPassExperimentTransport(budget, { ...options, priceBinding: { accountId: "deepseek-api", modelId: "deepseek-v4-pro", priceId: "pro" } });
    pro.beginTrial("calibration-pro", "calibration");
    const body = { model: "deepseek-v4-pro", max_tokens: 16384 };
    await pro.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify(body) });
    expect(budget.summary.estimatedPeakNanoCny).toBe(10 * 10560 + 10 * 352 + 3 * 31680);
    const wrong = new FirstPassExperimentTransport(budget, { ...options, priceBinding: { accountId: "deepseek-api", modelId: "deepseek-v4-pro", priceId: "flash" } });
    wrong.beginTrial("calibration-wrong", "calibration");
    await expect(wrong.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify(body) })).rejects.toThrow("price binding drift");
    expect(calls).toBe(1);
  });
  it("persists the reservation before fetch and keeps credential headers out of artifacts", async () => {
    let calls = 0;
    const test = setup(async () => {
      calls++;
      expect(readFileSync(path.join(test.root, "budget.jsonl"), "utf8")).toContain('"kind":"reserve"');
      return response();
    });
    await test.transport.fetch(request());
    expect(calls).toBe(1);
    expect(test.budget.summary.unsettled).toEqual([]);
    const file = path.join(test.root, "http", "discovery-P01-00-A-http-001", "request.json");
    expect(readFileSync(file, "utf8")).not.toContain("test-credential");
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(23);
  });

  it("serializes simultaneous recovery requests and counts every send", async () => {
    let concurrent = 0;
    let maximum = 0;
    const test = setup(async () => {
      maximum = Math.max(maximum, ++concurrent);
      await Promise.resolve();
      concurrent--;
      return response();
    });
    const pending = Promise.all([test.transport.fetch(request()), test.transport.fetch(request()), test.transport.fetch(request())]);
    expect(() => test.transport.beginTrial("discovery-P02-00-A", "discovery")).toThrow("queued");
    await pending;
    expect(maximum).toBe(1);
    expect(test.budget.summary.phases.discovery.httpRequests).toBe(3);
  });

  it("stops actual retries after missing usage, failed transport or malformed JSON", async () => {
    for (const behavior of ["missing", "transport", "json"] as const) {
      let calls = 0;
      const test = setup(async () => {
        calls++;
        if (behavior === "transport") throw new TypeError("network unavailable");
        return behavior === "json" ? new Response("unfinished") : Response.json({ error: "rate limited" }, { status: 429 });
      });
      await expect(test.transport.fetch(request())).rejects.toThrow();
      await expect(test.transport.fetch(request())).rejects.toThrow();
      expect(test.transport.stopReason).not.toBeNull();
      expect(() => test.transport.beginTrial("discovery-P02-00-A", "discovery")).toThrow();
      expect(calls).toBe(1);
      expect(test.budget.summary.unsettled).toHaveLength(1);
    }
  });

  it("rejects changed models/endpoints before reserving or sending", async () => {
    let calls = 0;
    const test = setup(async () => { calls++; return response(); });
    await expect(test.transport.fetch("https://test.invalid/models")).rejects.toThrow("endpoint");
    const other = setup(async () => { calls++; return response(); });
    await expect(other.transport.fetch("https://test.invalid/chat/completions", { method: "POST", body: JSON.stringify({ model: "other", max_tokens: 131_072 }) })).rejects.toThrow("drift");
    expect(calls).toBe(0);
    expect(test.budget.summary.phases.discovery.httpRequests).toBe(0);
  });

  it("stops the phase before an unaffordable send, without advancing to another trial", async () => {
    let calls = 0;
    const test = setup(async () => { calls++; return response(); });
    const transport = new FirstPassExperimentTransport(test.budget, { root: test.root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 8_000_000, outputTokenCeiling: 131_072, fetch: async () => { calls++; return response(); } });
    expect(() => transport.beginTrial("confirmation-P01-00-A", "discovery")).toThrow("identity");
    transport.beginTrial("discovery-P01-00-A", "discovery");
    await expect(transport.fetch(request())).rejects.toThrow("phase token reserve");
    expect(() => transport.beginTrial("discovery-P02-00-A", "discovery")).toThrow("phase token reserve");
    expect(test.budget.summary.unsettled).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it("prevents a second writer and refuses to overwrite different evidence", () => {
    const test = setup(async () => response());
    const unlock = lockExperiment(test.root);
    expect(() => lockExperiment(test.root)).toThrow("already owned");
    const file = path.join(test.root, "evidence.json");
    immutableExperimentJson(file, { value: 1 });
    immutableExperimentJson(file, { value: 1 });
    expect(() => immutableExperimentJson(file, { value: 2 })).toThrow("drift");
    unlock();
    const again = lockExperiment(test.root);
    again();
    expect(readdirSync(test.root)).toEqual(["evidence.json"]);
  });

  it("continues attempt IDs across process restarts without overwriting recorded requests", async () => {
    const test = setup(async () => response());
    await test.transport.fetch(request());
    const restarted = new FirstPassExperimentTransport(test.budget, { root: test.root, baseUrl: "https://test.invalid",
      inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072, fetch: async () => response() });
    restarted.beginTrial("discovery-P01-00-A", "discovery");
    await restarted.fetch(request());
    expect(readdirSync(path.join(test.root, "http"))).toEqual(["discovery-P01-00-A-http-001", "discovery-P01-00-A-http-002"]);
    expect(test.budget.summary.phases.discovery.knownTokens).toBe(46);
  });
});
