import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { constrainedBudgetPolicy, constrainedCatalog, constrainedOfflineScope, createConstrainedGateways } from "./action-compilation-constrained-first-pass";
import { AC_FP2_BUDGET } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { modelInvocationIdentity } from "../../src/engine/models/model-provider";
import { TEST_WORLD_HASH } from "../../src/engine/testing/world";

describe("AC-FP2 real gateway assembly", () => {
  it("carries an unknown prior send at its full monetary ceiling without inventing usage", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ac-fp2-budget-"));
    try {
      mkdirSync(path.join(directory, "v4"));
      const prior = new ExperimentBudget(path.join(directory, "v4/budget.jsonl"), AC_FP2_BUDGET);
      prior.reserve({ id: "unknown", trialId: "probes-S", phase: "probes", inputCeiling: 1000, outputCeiling: 100 });
      const policy = constrainedBudgetPolicy(directory);
      expect(policy.maximumNanoCny).toBe(AC_FP2_BUDGET.maximumNanoCny - prior.summary.reservedNanoCny);
      expect(policy.priorPreparation.sources[0]!.unresolved).toEqual(["unknown"]);
      expect(policy.priorPreparation.sources[0]!.knownEstimatedNanoCny).toBe(0);
      expect(prior.summary.unsettled).toEqual(["unknown"]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("assigns stable distinct canonical identities to offline probes and reviews", () => {
    const state = { worldHash: TEST_WORLD_HASH, revision: 7 };
    const ids = ["probe-R", "probe-SCF", "calibration-0000-0", "calibration-0000-1"].map((id) => {
      const scope = constrainedOfflineScope(state, id);
      expect(scope.runtimeIdentity).toEqual(state);
      expect(scope.correlation.executionId).toBe(`ac-fp2:${id}`);
      return modelInvocationIdentity(scope, "action-compilation", scope.subjectId, 1).modelInvocationId;
    });
    expect(new Set(ids).size).toBe(4);
  });
  it("assembles all variants with multiple configured accounts and no network", () => {
    const catalog = loadModelCatalog();
    const env = Object.fromEntries(Object.values(catalog.accounts).map((account) => [account.api_key_env, "fixture-not-a-real-key"]));
    let requests = 0;
    const gateways = createConstrainedGateways(catalog, env, path.resolve("test/fixtures/nonexistent-offline-registry"), async () => {
      requests++; throw new Error("offline assembly must not send");
    });
    expect(Object.keys(gateways)).toEqual(["chat", "responses", "review"]);
    for (const mode of ["chat", "responses", "review"] as const) expect(gateways[mode]!.catalog.hash).toBe(constrainedCatalog(catalog, mode).hash);
    expect(gateways.chat!.catalog).toBe(catalog);
    expect(requests).toBe(0);
  });
});
