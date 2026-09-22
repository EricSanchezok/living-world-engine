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
