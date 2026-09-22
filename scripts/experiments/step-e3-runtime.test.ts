import { cpSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createTestModelRegistrySnapshot } from "../../src/engine/testing/model-provider";
import { e3Environment } from "./step-e3-runtime";

it("configures a multi-account gateway without dispatching or rejecting unrelated dormant accounts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-e3-gateway-"));
  cpSync("config/models.yaml", path.join(root, "models.yaml"));
  const catalog = loadModelCatalog(path.join(root, "models.yaml"));
  const snapshot = vi.spyOn(ModelRegistry.prototype, "snapshot").mockReturnValue(createTestModelRegistrySnapshot(catalog));
  try {
    const environment = e3Environment(root, "P1");
    environment.beginTrial("discovery-configuration");
    await environment.drain();
    expect(environment.budget.summary.phases.discovery.httpRequests).toBe(0);
    expect(environment.stopReason()).toBeUndefined();
  } finally { snapshot.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

it("enforces the separate CNY 100 repair ceiling across restart without changing the original journal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-e3-repair-budget-"));
  cpSync("config/models.yaml", path.join(root, "models.yaml"));
  const catalog = loadModelCatalog(path.join(root, "models.yaml"));
  const snapshot = vi.spyOn(ModelRegistry.prototype, "snapshot").mockReturnValue(createTestModelRegistrySnapshot(catalog));
  try {
    const original = e3Environment(root, "P2");
    original.budget.reserve({ id: "original", trialId: "trajectory-original", phase: "trajectory", priceId: "flash", inputCeiling: 1_000_000, outputCeiling: 100_000 });
    original.budget.settle("original", { input: 1_000_000, output: 100_000, cacheHit: 0 });
    const before = original.budget.summary;
    const repaired = e3Environment(root, "R1");
    expect(repaired.budget.summary.estimatedPeakNanoCny).toBe(0);
    for (let i = 0; i < 35; i++) {
      repaired.budget.reserve({ id: `repair-${i}`, trialId: "trajectory-repair", phase: "trajectory", priceId: "flash", inputCeiling: 1_000_000, outputCeiling: 100_000 });
      repaired.budget.settle(`repair-${i}`, { input: 1_000_000, output: 100_000, cacheHit: 0 });
    }
    const restarted = e3Environment(root, "R1");
    expect(restarted.budget.summary.estimatedPeakNanoCny).toBe(98e9);
    expect(restarted.budget.summary.remainingNanoCny).toBe(2e9);
    expect(() => restarted.budget.reserve({ id: "over-cap", trialId: "trajectory-repair", phase: "trajectory", priceId: "flash", inputCeiling: 1_000_000, outputCeiling: 100_000 }))
      .toThrow("CNY budget exhausted");
    expect(e3Environment(root, "P2").budget.summary).toEqual(before);
  } finally { snapshot.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});
