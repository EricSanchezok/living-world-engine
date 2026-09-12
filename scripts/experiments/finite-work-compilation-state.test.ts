import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { createTestModelCatalog } from "../../src/engine/testing/model-provider";
import { createHistoryReplayBase } from "../../src/engine/runtime/history-replay";
import { finiteWorkWorldTemplate } from "./step-finite-work-world";
import { finiteWorkCompilationState } from "./finite-work-compilation-state";

it("binds a finite-work compiler counterfactual without changing original cognition, actions or other mechanics", () => {
  const template = loadWorldTemplate("test/fixtures/open-world-script");
  const options = { seed: 47, modelCatalog: createTestModelCatalog() };
  const before = buildWorldDefinition(template, options);
  const after = buildWorldDefinition(finiteWorkWorldTemplate(template), options);
  // Arrival can advance the revision while no action or world time has elapsed.
  const source = { ...structuredClone(before.initialState), revision: 1, historyBase: createHistoryReplayBase(before.initialState) };
  const original = JSON.stringify(source);
  const result = finiteWorkCompilationState(source, before, after);
  expect(JSON.stringify(source)).toBe(original);
  expect(result.provenance).toMatchObject({ kind: "counterfactual-first-action-compilation", sourceRevision: 1, gameplayCommit: false, historicalCostsIncludedInLatency: false });
  expect(result.state.agents).toEqual(source.agents);
  expect(result.state.worldHash).toBe(after.contentHash);
  expect(result.state.truth.mechanics.temporalProfiles["work-until-objective"]).toMatchObject({ kind: "goal", checkEverySeconds: 300 });
  expect(() => finiteWorkCompilationState({ ...source, step: 1 }, before, after)).toThrow("first-action");
  const drift = structuredClone(after);
  drift.initialState.truth.mechanics.temporalProfiles["brief-action"].name += " changed";
  expect(() => finiteWorkCompilationState(source, before, drift)).toThrow("unrelated mechanics");
});
