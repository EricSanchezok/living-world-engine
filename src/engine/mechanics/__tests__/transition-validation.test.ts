import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import type { StructuredModelProvider } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";

it.each(["missing", "duplicate", "causal-clock", "causal-placement", "causal-absence", "receipt"] as const)("rejects %s candidates before paid observation work and repairs at the actual boundary", async (defect) => {
  let transitions = 0;
  let observations = 0;
  let observationsBeforeRepair = -1;
  let repairReasons: string[] = [];
  let failureEvidence: unknown[] = [];
  let rejectedCandidate: unknown;
  const base = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "observation-renderer") observations += 1;
    return deterministicModelOutput(profileId, context);
  });
  const provider: StructuredModelProvider = {
    catalog: base.catalog, availableProfileSummaries: role => base.availableProfileSummaries(role),
    assertProfilesAvailable: ids => base.assertProfilesAvailable(ids),
    async generateStructured(request) {
      if (request.role !== "truth-transition" || request.schemaName !== "truth_transition") return base.generateStructured(request);
      transitions += 1;
      const input = request.context as {
        repair: { issues: Array<{ reason: string; originalValue: unknown }>; previousOutput: unknown };
        state: { temporalBoundary: { reasons: Array<{ kind: string }>; toElapsedSeconds: number } };
      };
      expect(input.state.temporalBoundary.reasons.some((reason) => reason.kind === "activity_completion")).toBe(true);
      if (transitions > 1) {
        expect(input.repair.previousOutput).toEqual(rejectedCandidate);
        failureEvidence = input.repair.issues.map((issue) => issue.originalValue);
        observationsBeforeRepair = observations;
        repairReasons = input.repair.issues.map((issue) => issue.reason);
      }
      const generated = await base.generateStructured(request);
      const output = generated.value as { outcomes: Array<{ actionRef: string; status: string; assertions: unknown[] }>; operations: unknown[] };
      if (transitions === 1) {
        if (defect === "missing" || defect === "duplicate") {
          output.outcomes = defect === "missing" ? [] : [output.outcomes[0]!, output.outcomes[0]!];
        } else if (defect === "receipt") {
          output.outcomes[0]!.status = "blocked";
        } else if (defect === "causal-absence") {
          output.outcomes[0]!.assertions = [{ kind: "entity_absent", entityRef: "ref:entity:player" }];
        } else {
          output.operations.push({ kind: "place_entity", entityRef: "ref:entity:player", placementRef: "ref:placement:gate",
            causes: [{ kind: "action", ref: output.outcomes[0]!.actionRef }],
            assertions: [defect === "causal-clock"
              ? { kind: "elapsed_seconds_compare", operator: "eq", value: input.state.temporalBoundary.toElapsedSeconds }
              : { kind: "placement_equals", entityRef: "ref:entity:player", placementRef: "ref:placement:gate" }],
          });
        }
        rejectedCandidate = structuredClone(output);
      }
      return generated;
    },
  };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({
    player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
  }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: [{
    submissionId: "inspect-courtyard", agentId: "player", rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [],
  }] });
  expect(transitions).toBe(2);
  expect.soft(observationsBeforeRepair).toBe(0);
  expect(observations).toBeGreaterThan(0);
  expect(repairReasons.join(" ")).not.toContain("emit exactly one status=continuing");
  if (defect === "missing") expect(repairReasons.join(" ")).toContain("pre-step active status or a checkpoint alone does not determine completion");
  if (defect.startsWith("causal-")) expect(repairReasons.join(" ")).toContain("causal assertions failed");
  if (defect === "causal-absence") expect(failureEvidence).toEqual([expect.objectContaining({
    assertion: { kind: "entity_absent", entityRef: "ref:entity:player" },
    passed: false, observed: { present: true }, evaluation: { phase: "after-all-operations" },
    actionRef: expect.stringMatching(/^ref:action:/),
  })]);
  if (defect === "causal-placement") expect(failureEvidence).toEqual([expect.objectContaining({
    assertion: { kind: "placement_equals", entityRef: "ref:entity:player", placementRef: "ref:placement:gate" },
    observed: { known: true, placementRef: "ref:placement:courtyard" },
    evaluation: { phase: "before-operation", expandedOperationIndex: 0 },
  })]);
  if (defect === "causal-clock") expect(failureEvidence).toEqual([expect.objectContaining({
    observed: source.truth.elapsedSeconds, evaluation: { phase: "before-operation", expandedOperationIndex: 0 },
  })]);
  if (defect === "receipt") expect(repairReasons.join(" ")).toContain("contradicts its resolution receipt");
  expect(result.committed.outcomes).toHaveLength(1);
  expect(result.committed.outcomes[0]!.status).not.toBe("continuing");
  expect(result.state.revision).toBe(source.revision + 1);
  expect(result.state.truth.placements.player).toBe(source.truth.placements.player);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
