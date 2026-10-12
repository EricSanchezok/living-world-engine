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
});
