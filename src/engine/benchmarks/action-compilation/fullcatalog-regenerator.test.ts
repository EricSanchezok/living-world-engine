import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { DEFAULT_ALGORITHM_REF } from "../../algorithms/registry";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { DeterministicModelProvider } from "../../testing/model-provider";
import { readActionCompilationCapturedSources } from "../source-capture";
import { regenerateActionCompilationFullCatalog } from "./fullcatalog-regenerator";

describe("FullCatalog reference regenerator", () => {
  it("replays the exact captured state/actions and validates the full context hash", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const state = structuredClone(definition.initialState);
    const agent = Object.values(state.agents).sort((left, right) => left.id.localeCompare(right.id))[0]!;
    const actions = [{
      id: "benchmark-action",
      actorId: agent.id,
      baseRevision: state.revision,
      rawText: "wait and observe",
      goal: "observe",
      means: null,
      targetIds: [],
    }];
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    await compileActions(provider, state, actions, {
      workloadId: "capture-workload",
      batchId: "capture-batch",
      correlation: { executionId: "capture-execution", revision: state.revision },
      observer,
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
      modelRegistrySnapshotHash: "a".repeat(64),
      executionAlgorithmRef: DEFAULT_ALGORITHM_REF,
    }, definition.modelProfiles.grounding, 12);
    const [source] = readActionCompilationCapturedSources(observer.events);
    expect(source).toBeDefined();
    const reference = await regenerateActionCompilationFullCatalog(source!, new DeterministicModelProvider(provider.catalog));
    expect(reference).toMatchObject({
      fullyValidated: true,
      fullContextHash: source!.fullContextHash,
      providerRequests: 1,
    });
    expect(reference.slots).toHaveLength(1);
  });
});
