import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevLiveBudget, JEV_BUDGET_POLICY, JEV_PLANNING_NANO_CNY } from "./live-budget";

const roots: string[] = [];
const directory = () => { const root = mkdtempSync(path.join(os.tmpdir(), "jev-budget-")); roots.push(root); return root; };
const body = JSON.stringify({ model: "deepseek-flash", max_tokens: 20 });
const nativeBody = JSON.stringify({ model: "jev-1.13.0" });
function holdTokens(live: ReturnType<typeof createJevLiveBudget>, outputCeiling: number) {
  live.budget.reserve({ id: "historical", trialId: "closed-history", phase: "trajectory", priceId: "jev", inputCeiling: 1, outputCeiling });
  live.budget.markUnknown("historical");
  live.budget.quarantineUnknown("historical", { reason: "Fixture retains the full unknown historical reservation", evidenceHash: "d".repeat(64) });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("one cumulative live model budget", () => {
  it("waits for a live token reservation without changing historical holds or sending twice", async () => {
    const live = createJevLiveBudget(directory()); holdTokens(live, 994_000_000);
    const held = live.budget.summary.reservedNanoCny;
    let finishFirst!: (response: Response) => void;
    const provider = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishFirst = resolve; }))
      .mockImplementation(async () => Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    const send = () => live.transport("typesafe-api", provider)("https://unused.test", { body: nativeBody });
    const first = send(), second = send();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2); // Historical hold and the first send.
    finishFirst(Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    await Promise.all([first, second]); await live.drain();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(3);
    expect(live.budget.summary.reservedNanoCny).toBe(held);
    expect(live.budget.policy.maxKnownTokens.trajectory).toBe(1_000_000_000);
    expect(live.budget.summary.quarantinedUnknown).toEqual(["historical"]); live.close();
  });
  it("waits for temporary monetary reservations under the same grant", async () => {
    const live = createJevLiveBudget(directory());
    live.budget.authorizeTranche({ id: "limited", amountNanoCny: 30_000_000, priorExposureNanoCny: 0,
      reason: "Fixture authorizes one concurrent native reservation", evidenceHash: "e".repeat(64) });
    let finishFirst!: (response: Response) => void;
    const provider = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finishFirst = resolve; }))
      .mockImplementation(async () => Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    const send = () => live.transport("typesafe-api", provider)("https://unused.test", { body: nativeBody });
    const first = send(), second = send(); expect(provider).toHaveBeenCalledTimes(1);
    finishFirst(Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    await Promise.all([first, second]); await live.drain();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(live.budget.summary.tranche).toMatchObject({ amountNanoCny: 30_000_000, knownNanoCny: 2 * 10 * 336, reservedNanoCny: 0 });
    live.close();
  });
  it("does not wait on historical holds when no live reservation can free capacity", async () => {
    const live = createJevLiveBudget(directory()); holdTokens(live, 997_000_000);
    const provider = vi.fn();
    await expect(live.transport("typesafe-api", provider)("https://unused.test", { body: nativeBody }))
      .rejects.toMatchObject({ limitCode: "token-limit" });
    await live.drain(); expect(provider).not.toHaveBeenCalled();
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(1); live.close();
  });
  it("blocks a queued send if the active send ends with unknown usage", async () => {
    const live = createJevLiveBudget(directory()); holdTokens(live, 994_000_000);
    let failFirst!: (error: Error) => void;
    const provider = vi.fn(() => new Promise<Response>((_, reject) => { failFirst = reject; }));
    const send = () => live.transport("typesafe-api", provider)("https://unused.test", { body: nativeBody });
    const first = send(), second = send();
    const failures = Promise.all([expect(first).rejects.toThrow("connection lost"),
      expect(second).rejects.toMatchObject({ limitCode: "usage-unresolved" })]);
    failFirst(new Error("connection lost")); await failures; await live.drain();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(live.budget.summary.blockingUnknown).toHaveLength(1);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2); live.close();
  });
  it("cancels a queued send before reservation and transport", async () => {
    const live = createJevLiveBudget(directory()); holdTokens(live, 994_000_000);
    let finishFirst!: (response: Response) => void;
    const provider = vi.fn(() => new Promise<Response>(resolve => { finishFirst = resolve; }));
    const send = live.transport("typesafe-api", provider), controller = new AbortController();
    const first = send("https://unused.test", { body: nativeBody });
    const second = send("https://unused.test", { body: nativeBody, signal: controller.signal });
    const cancelled = expect(second).rejects.toThrow("cancel queued send");
    controller.abort(new Error("cancel queued send")); await cancelled;
    expect(provider).toHaveBeenCalledTimes(1);
    finishFirst(Response.json({ usage: { input_tokens: 10, output_tokens: 20 } })); await first; await live.drain();
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2); live.close();
  });
  it("honors a stop recorded while waiting without sending the queued request", async () => {
    const stop = { reason: undefined as string | undefined };
    const live = createJevLiveBudget(directory(), () => stop.reason); holdTokens(live, 994_000_000);
    let finishFirst!: (response: Response) => void;
    const provider = vi.fn(() => new Promise<Response>(resolve => { finishFirst = resolve; }));
    const send = () => live.transport("typesafe-api", provider)("https://unused.test", { body: nativeBody });
    const first = send(), second = send(), rejected = expect(second).rejects.toThrow("experiment stopped");
    stop.reason = "experiment stopped";
    finishFirst(Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    await first; await rejected; await live.drain();
    expect(provider).toHaveBeenCalledTimes(1);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2); live.close();
  });
  it("holds streaming capacity until terminal usage settles", async () => {
    const live = createJevLiveBudget(directory()); holdTokens(live, 999_993_000);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8 };
    const provider = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }),
      { headers: { "content-type": "text/event-stream" } }))
      .mockImplementation(async () => Response.json({ usage }));
    const send = () => live.transport("deepseek-api", provider)("https://unused.test", { body });
    const first = await send(), second = send(); expect(provider).toHaveBeenCalledTimes(1);
    const firstBody = first.text();
    stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`)); stream.close();
    await firstBody; await second; await live.drain(); expect(provider).toHaveBeenCalledTimes(2);
    expect(live.budget.summary.quarantinedUnknown).toEqual(["historical"]);
    expect(live.budget.summary.phases.trajectory.knownTokens).toBe(28); live.close();
  });
  it("stops at the explicit request cap before transport and resumes only under a new recorded grant", async () => {
    const root = directory(), live = createJevLiveBudget(root);
    const evidence = { reason: "Explicit bounded request capacity for newly authorized work", evidenceHash: "a".repeat(64) };
    live.budget.authorizeTranche({ id: "first", amountNanoCny: 1_000_000_000, priorExposureNanoCny: 0,
      ...evidence, requestCapacity: [{ phase: "trajectory", priorHttpRequests: 0, additionalRequests: 1 }] });
    const provider = vi.fn(async () => Response.json({ usage: { input_tokens: 10, output_tokens: 20 } }));
    const request = () => live.transport("typesafe-api", provider)("https://unused.test", { body: JSON.stringify({ model: "jev-1.13.0" }) });
    await request(); await live.drain();
    await expect(request()).rejects.toMatchObject({ limitCode: "request-limit" }); await live.drain();
    expect(provider).toHaveBeenCalledTimes(1);
    const before = live.budget.summary;
    live.budget.authorizeTranche({ id: "second", amountNanoCny: 1_000_000_000,
      priorExposureNanoCny: before.estimatedPeakNanoCny + before.reservedNanoCny,
      ...evidence, evidenceHash: "b".repeat(64),
      requestCapacity: [{ phase: "trajectory", priorHttpRequests: 1, additionalRequests: 1 }] });
    await request(); await live.drain();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2);
    expect(live.budget.summary.tranche?.knownNanoCny).toBe(10 * 336);
    live.close();
    const reopened = createJevLiveBudget(root);
    expect(reopened.budget.summary.requestLimits.trajectory).toBe(2);
    reopened.close();
  });
  it("reserves the full native batch boundary and the complete request without rejecting context by bytes", async () => {
    const root = directory(), live = createJevLiveBudget(root);
    for (const [state, input] of [["short", 65_536], ["字".repeat(30_000), 80_000]] as const) {
      await live.transport("typesafe-api", async () => Response.json({ usage: { input_tokens: input, output_tokens: 20 } }))(
        "https://unused.test", { body: JSON.stringify({ model: "jev-1.13.0", state }) });
    }
    await live.drain(); expect(live.budget.summary.unsettled).toEqual([]);
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2); live.close();
  });
  it("retains actual provider usage when a reservation overrun stops settlement", async () => {
    const root = directory(), live = createJevLiveBudget(root);
    await expect(live.transport("typesafe-api", async () => Response.json({ usage: { input_tokens: 90_000, output_tokens: 20 } }))(
      "https://unused.test", { body: JSON.stringify({ model: "jev-1.13.0" }) })).rejects.toThrow("reservation ceiling");
    await live.drain(); const id = live.budget.summary.blockingUnknown[0]!;
    expect(JSON.parse(readFileSync(path.join(root, "usage-errors", `${id}.json`), "utf8"))).toMatchObject({ id, usage: { input: 90_000, output: 20, cacheHit: 0 } });
    live.close();
  });
  it("includes planning spend, excludes concurrent writers and retains arm/phase identity", async () => {
    expect(JEV_BUDGET_POLICY.maximumNanoCny + JEV_PLANNING_NANO_CNY).toBe(100_000_000_000);
    const root = directory(), live = createJevLiveBudget(root);
    expect(() => createJevLiveBudget(root)).toThrow();
    live.beginTrial("canary-1-A-cold");
    const transport = vi.fn(async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8 } }));
    await live.transport("deepseek-api", transport)("https://unused.test", { body });
    await live.drain();
    expect(live.budget.summary.phases.trajectory.httpRequests).toBe(1);
    expect(live.budget.summary.unsettled).toEqual([]);
    expect(readFileSync(path.join(root, "budget.jsonl"), "utf8")).toContain("canary-1-A-cold");
    live.close();
    const resumed = createJevLiveBudget(root);
    expect(resumed.budget.summary.phases.trajectory.httpRequests).toBe(1); resumed.close();
  });
  it("stops new dispatch before charging while retaining uncertain sends at their ceiling", async () => {
    let stop: string | undefined;
    const live = createJevLiveBudget(directory(), () => stop), transport = vi.fn(async () => { throw new Error("connection lost"); });
    stop = "deadline";
    await expect(live.transport("deepseek-api", transport)("https://unused.test", { body })).rejects.toThrow("deadline");
    expect(transport).not.toHaveBeenCalled(); expect(live.budget.summary.phases.trajectory.httpRequests).toBe(0);
    stop = undefined;
    await expect(live.transport("deepseek-api", transport)("https://unused.test", { body })).rejects.toThrow("connection lost");
    await live.drain(); expect(live.budget.summary.blockingUnknown).toHaveLength(1);
    expect(live.budget.summary.reservedNanoCny).toBeGreaterThan(0); live.close();
  });
  it("will not release or relabel in-flight requests", async () => {
    const live = createJevLiveBudget(directory());
    let settle!: (value: Response) => void;
    const transport = () => new Promise<Response>(resolve => { settle = resolve; });
    const pending = live.transport("typesafe-api", transport)("https://unused.test", { body: JSON.stringify({ model: "jev-1.13.0" }) });
    expect(() => live.close()).toThrow("unsettled"); expect(() => live.beginTrial("another")).toThrow("during dispatch");
    settle(Response.json({ usage: { input_tokens: 10, output_tokens: 20 } })); await pending; await live.drain(); live.close();
  });
  it("preserves terminal HTTP error bodies and their cost ceiling while permitting context recovery", async () => {
    const root = directory(), live = createJevLiveBudget(root);
    const response = await live.transport("typesafe-api", async () => Response.json({ detail: "context token limit exceeded" }, { status: 400 }))(
      "https://unused.test", { body: JSON.stringify({ model: "jev-1.13.0" }) });
    expect(response.status).toBe(400); expect(await response.text()).toContain("context token limit exceeded");
    const held = live.budget.summary.reservedNanoCny;
    expect(held).toBeGreaterThan(0); expect(live.budget.summary.blockingUnknown).toEqual([]);
    expect(live.budget.summary.rejectedRequests).toHaveLength(1);
    await live.transport("deepseek-api", async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 8 } }))(
      "https://unused.test", { body });
    await live.drain(); expect(live.budget.summary.phases.trajectory.httpRequests).toBe(2);
    expect(live.budget.summary.reservedNanoCny).toBe(held); live.close();
    const restored = createJevLiveBudget(root); expect(restored.budget.summary.reservedNanoCny).toBe(held); restored.close();
  });
});
