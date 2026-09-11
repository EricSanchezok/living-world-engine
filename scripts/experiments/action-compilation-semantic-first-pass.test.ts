import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reportSemanticFirstPass } from "./action-compilation-semantic-first-pass";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { AC_FP3_BUDGET } from "../../src/engine/benchmarks/action-compilation/semantic-first-pass-protocol";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(path.join(os.tmpdir(), "ac-fp3-report-")); roots.push(value); return value; }

describe("AC-FP3 partial report entry point", () => {
  it("reports preparation honestly without frozen inputs or completed.json", () => {
    const directory = root();
    const result = reportSemanticFirstPass(directory);
    expect(result.report.status).toBe("preparation");
    expect(result.report.mainExperimentStarted).toBe(false);
    expect(result.report.compilationImprovementEstablished).toBe(false);
    expect(readFileSync(path.join(result.directory, "report.md"), "utf8")).toContain("has not started");
    expect(reportSemanticFirstPass(directory).directory).toBe(result.directory);
  });
  it("keeps an interrupted paid request reserved and publishes a stop without drawing another sample", () => {
    const directory = root();
    const budget = new ExperimentBudget(path.join(directory, "budget.jsonl"), AC_FP3_BUDGET);
    budget.reserve({ id: "probes-pro-http-001", trialId: "probes-pro", phase: "probes", inputCeiling: 100,
      outputCeiling: 16384, priceId: "pro" });
    const result = reportSemanticFirstPass(directory);
    expect(result.report.status).toBe("stopped-unknown-usage");
    expect(result.report.budget!.reservedNanoCny).toBeGreaterThan(0);
    expect(result.report.budget!.estimatedPeakNanoCny).toBe(0);
    expect(result.report.budget!.unsettled).toEqual(["probes-pro-http-001"]);
    expect(result.report.mainExperimentComplete).toBe(false);
  });
  it("reports a corrupted budget as unavailable, never a zero-cost completed experiment", () => {
    const directory = root();
    writeFileSync(path.join(directory, "budget.jsonl"), '{"incomplete":');
    const result = reportSemanticFirstPass(directory);
    expect(result.report.status).toBe("stopped-budget-integrity");
    expect(result.report.budget).toBeNull();
    expect(result.report.budgetError).toContain("incomplete");
    expect(readFileSync(path.join(result.directory, "report.md"), "utf8")).toContain("CNY: unavailable");
  });
});
