import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import type { AgentActionProposal, FactValue, SimulationState } from "../../../contracts/model";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../../testing/model-provider";
import { compileActions } from "../action-compiler";
import { DEFAULT_EAGER_OUTPUT_RECOVERY } from "../eager-slot-batching";

const action: AgentActionProposal = {
  id: "assert-gate-state", actorId: "player", baseRevision: 0,
  rawText: "Observe the gate while its state remains unchanged.",
  goal: "Observe the gate", means: null, targetIds: [],
};
const scope = (state: SimulationState) => ({
  workloadId: "compiler-boundary", batchId: "batch",
  runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
});
const noRepair = { ...DEFAULT_EAGER_OUTPUT_RECOVERY, maxRepairs: 0 };

describe("Action Compilation materialization boundaries", () => {
  it.each([true, false])("checks an explicit goal-work prerequisite against onset truth (%s)", async (matches) => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicActionCompilationBatch(profileId, context, (compilation) => {
        compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "goal-work");
        compilation.temporalPlan.continuationAssertions = [{ kind: "fact_matches",
          factRef: referenceHandleFor("fact", "gate-lock"), expected: { kind: "boolean", value: matches } }];
      }));
    const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    });
    state.truth.mechanics.temporalProfiles["goal-work"] = { id: "goal-work", name: "Finite goal", kind: "goal",
      checkEverySeconds: 60, selection: { semanticTags: ["finite-work"], evidenceRequirement: "none" },
      interruptible: true, reactionFallback: "continue_if_valid", resourceClaims: [{ resourceId: "foreground", amount: 1 }] };
    state.truth.facts["gate-lock"]!.value = { kind: "boolean", value: true };
    const before = contentHash(state);
    const pending = compileActions(provider, state, [action], scope(state), "truth-engine", 12, noRepair);
    if (matches) expect((await pending).compilations[0]!.plan).toMatchObject({ mode: "goal", completionAtSeconds: null,
      continuationAssertions: [{ kind: "fact_matches", factId: "gate-lock", expected: { kind: "boolean", value: true } }] });
    else await expect(pending).rejects.toThrow(/failed after repairs/);
    expect(provider.requests).toHaveLength(1);
    expect(contentHash(state)).toBe(before);
  });

  it.each<FactValue>([
    { kind: "text", value: "sealed" },
    { kind: "number", value: 2 },
    { kind: "boolean", value: false },
    { kind: "none" },
    { kind: "entity", entityId: "gate" },
  ])("materializes and evaluates a $kind fact assertion through compileActions", async (value) => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicActionCompilationBatch(profileId, context, (compilation) => {
        compilation.temporalPlan.continuationAssertions = [{
          kind: "fact_matches", factRef: referenceHandleFor("fact", "gate-lock"),
          expected: value.kind === "entity"
            ? { kind: "entity", entityRef: referenceHandleFor("entity", value.entityId) }
            : structuredClone(value),
        }];
      }));
    const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    });
    state.truth.facts["gate-lock"]!.value = structuredClone(value);
    const before = contentHash(state);
    const result = await compileActions(provider, state, [action], scope(state), "truth-engine", 12, noRepair);
    expect(result.compilations[0]!.plan.continuationAssertions).toEqual([{
      kind: "fact_matches", factId: "gate-lock", expected: value,
    }]);
    expect(provider.requests).toHaveLength(1);
    expect(contentHash(state)).toBe(before);
  });

  it("rejects an entity-valued assertion whose resolved target does not match truth", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicActionCompilationBatch(profileId, context, (compilation) => {
        compilation.temporalPlan.continuationAssertions = [{
          kind: "fact_matches", factRef: referenceHandleFor("fact", "gate-lock"),
          expected: { kind: "entity", entityRef: referenceHandleFor("entity", "player") },
        }];
      }));
    const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    });
    state.truth.facts["gate-lock"]!.value = { kind: "entity", entityId: "gate" };
    const before = contentHash(state);
    await expect(compileActions(provider, state, [action], scope(state), "truth-engine", 12, noRepair))
      .rejects.toThrow(/failed after repairs/);
    expect(contentHash(state)).toBe(before);
  });

  it("accepts a newly selected dependency actually displayed in a semantic repair", async () => {
    let requests = 0;
    const gateFactKey = actionCompilationCandidateKeyForHandle(referenceHandleFor("fact", "gate-lock"));
    const provider = new ScriptedModelProvider(({ profileId, context }) => {
      requests += 1;
      if (requests > 1) {
        const catalog = (context as { referenceCatalog: { candidates: Array<{ candidateKey: string }> } }).referenceCatalog;
        expect(catalog.candidates.some((candidate) => candidate.candidateKey === gateFactKey)).toBe(true);
      }
      return deterministicActionCompilationBatch(profileId, context, (compilation) => {
        if (requests === 1) {
          compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "missing-temporal-profile");
        } else {
          compilation.interactionDependency.stateDependencies.requiredExistingRefs.push(referenceHandleFor("fact", "gate-lock"));
        }
      });
    });
    const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    });
    const before = contentHash(state);
    const result = await compileActions(provider, state, [action], scope(state), "truth-engine", 12);
    expect(requests).toBe(2);
    expect(result.compilations).toHaveLength(1);
    expect(contentHash(state)).toBe(before);
  });
});
