import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevLiveBudget, JEV_BUDGET_POLICY, JEV_PLANNING_NANO_CNY } from "./live-budget";

const roots: string[] = [];
const directory = () => { const root = mkdtempSync(path.join(os.tmpdir(), "jev-budget-")); roots.push(root); return root; };
const body = JSON.stringify({ model: "deepseek-flash", max_tokens: 20 });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("one cumulative live model budget", () => {
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
