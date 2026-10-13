import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExperimentBudget } from "../action-compilation/experiment-budget";
import { createJevLiveRuntime, JEV_BUDGET_POLICY } from "./live-runtime";

const roots: string[] = [];
function root() { const directory = mkdtempSync(path.join(os.tmpdir(), "jev-budget-")); roots.push(directory); return directory; }
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("cumulative Jev qualification budget", () => {
  it("can increase a reviewed unknown hold without inventing usage or another request", () => {
    const journal = path.join(root(), "budget.jsonl"), budget = new ExperimentBudget(journal, JEV_BUDGET_POLICY);
    budget.reserve({ id: "native", trialId: "closed", phase: "trajectory", priceId: "jev", inputCeiling: 64000, outputCeiling: 4e6 });
    budget.markUnknown("native");
    const evidence = { reason: "Reviewed lost usage; keep a larger conservative reserve", evidenceHash: "a".repeat(64) };
    expect(() => budget.quarantineUnknown("native", { ...evidence, retainedCeiling: { input: 63000, output: 4e6 } })).toThrow("cannot decrease");
    budget.quarantineUnknown("native", { ...evidence, retainedCeiling: { input: 100000, output: 4e6 } });
    const restored = new ExperimentBudget(journal, JEV_BUDGET_POLICY);
    expect(restored.summary.reservedNanoCny).toBe(100000 * 336);
    expect(restored.summary.estimatedPeakNanoCny).toBe(0);
    expect(restored.summary.phases.trajectory.httpRequests).toBe(1);
    expect(restored.summary.blockingUnknown).toEqual([]);
    expect(restored.summary.unknown).toEqual(["native"]);
    expect(() => restored.reserve({ id: "again", trialId: "closed", phase: "trajectory", priceId: "jev", inputCeiling: 1, outputCeiling: 1 })).toThrow("permanently closed");
  });
  it("deducts planning probes and reserves free-output native calls against the same ceiling", () => {
    expect(JEV_BUDGET_POLICY.maximumNanoCny).toBeLessThan(100e9);
    const journal = path.join(root(), "budget.jsonl"), budget = new ExperimentBudget(journal, JEV_BUDGET_POLICY);
    budget.reserve({ id: "native", trialId: "canary", phase: "trajectory", priceId: "jev", inputCeiling: 64000, outputCeiling: 4e6 });
    expect(budget.summary.reservedNanoCny).toBe(64000 * 336);
    budget.settle("native", { input: 1000, output: 50, cacheHit: 0 });
    const restored = new ExperimentBudget(journal, JEV_BUDGET_POLICY);
    expect(restored.summary.estimatedPeakNanoCny).toBe(336000);
    expect(restored.summary.phases.trajectory.httpRequests).toBe(1);
    expect(() => restored.settle("native", { input: 1000, output: 50, cacheHit: 0 })).toThrow("already settled");
  });
  it("holds unknown usage at its full reserve and rejects a request beyond the cumulative ceiling", () => {
    const budget = new ExperimentBudget(path.join(root(), "budget.jsonl"), { ...JEV_BUDGET_POLICY, maximumNanoCny: 64000 * 336 });
    budget.reserve({ id: "native", trialId: "canary", phase: "trajectory", priceId: "jev", inputCeiling: 64000, outputCeiling: 1000 });
    budget.markUnknown("native");
    expect(budget.summary.remainingNanoCny).toBe(0);
    expect(() => budget.reserve({ id: "next", trialId: "next", phase: "trajectory", priceId: "jev", inputCeiling: 1, outputCeiling: 1 })).toThrow("unsettled provider usage blocks further sends");
  });
  it("excludes simultaneous processes from the shared paid-call journal", () => {
    const directory = root(), runtime = createJevLiveRuntime(directory);
    expect(() => createJevLiveRuntime(directory)).toThrow();
    runtime.close("test");
    const reopened = createJevLiveRuntime(directory); reopened.close("test-reopen");
  });
});
