import path from "node:path";
import { expect, it } from "vitest";
import { stepEfficiencyAlgorithmRef } from "./step-efficiency-playtest";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { orderedRandomAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";

const contexts = (input: StructuredModelRequest<unknown>) => {
  const state = (input.context as { state: unknown }).state;
  return isSharedBatchContext(state) ? expandSharedBatchContexts(state) : [input.context];
};

async function run(enabled: boolean, fail = false) {
  const selected = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1",
    truthTransport: "shared-state-first-v1", truthFlushBoundary: "post-promise-v1",
    ...(enabled ? { planningPartition: "balanced-two-v1" } : {}) });
  expect(registerBuiltinAlgorithms().has(selected)).toBe(true);
  const base = orderedRandomAlgorithmRef(FULL_CATALOG_ALGORITHM_REF), original = base.children.truthResolution!;
  const composition = defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution: defineAlgorithmRef({ ...original,
    children: { ...original.children, batching: selected.children.truthResolution!.children.batching! } }) } });
  const physical: StructuredModelRequest<unknown>[] = [];
  const provider = new ScriptedModelProvider(({ role, schemaName, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
      compilation.interactionDependency = deterministicInteractionDependency({ reads: [], writes: [{ kind: "entity", id: action.actorId }],
        audienceAgentIds: [action.actorId], sharedResourceClaims: [] });
    });
    if (fail && schemaName === "truth_resolution_plan_commit" && physical.filter(input => input.schemaName === schemaName).length === 2)
      throw new ModelConfigurationError("controlled sibling planning failure");
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = input => { physical.push(input); return generate(input); };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, registerBuiltinAlgorithms().create(composition, { provider }));
  await engine.bootstrapAgents();
  const source = engine.snapshot, sourceHash = contentHash(source);
  const pending = engine.step(Object.fromEntries(Object.keys(source.agents).map(agentId => [agentId,
    { kind: "external" as const, agentId, participantId: `test-${agentId}` }])), {
    expectedRevision: source.revision, trigger: "participant_action", externalActions: Object.keys(source.agents).map(agentId => ({
      submissionId: `action-${agentId}`, agentId, rawText: "Remain here and look around.", goal: "Observe my surroundings", means: null, targetIds: [],
    })),
  });
  if (fail) {
    await expect(pending).rejects.toThrow();
    expect(contentHash(engine.snapshot)).toBe(sourceHash);
    return { selected, result: null, physical };
  }
  const result = await pending;
  expect(result.state.revision).toBe(source.revision + 1);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  return { selected, result, physical };
}

it("uses the registered planning partition while preserving real world commits and replay", async () => {
  const before = await run(false), after = await run(true);
  expect(after.selected.manifestHash).not.toBe(before.selected.manifestHash);
  const plans = (inputs: StructuredModelRequest<unknown>[]) => inputs.filter(input => input.schemaName.startsWith("truth_resolution_plan_commit"));
  expect(plans(before.physical)).toHaveLength(1);
  expect(plans(after.physical)).toHaveLength(2);
  const ordered = (inputs: unknown[]) => [...inputs].sort((a, b) => contentHash(a).localeCompare(contentHash(b)));
  expect(ordered(plans(after.physical).flatMap(contexts))).toEqual(ordered(plans(before.physical).flatMap(contexts)));
  expect(after.result!.state.truth).toEqual(before.result!.state.truth);
  expect(after.result!.state.agents).toEqual(before.result!.state.agents);
  expect(after.result!.committed.observations).toEqual(before.result!.committed.observations);
  const later = (inputs: StructuredModelRequest<unknown>[]) => inputs.filter(input => !input.schemaName.startsWith("truth_resolution_plan_commit"));
  expect(later(after.physical).map(input => input.schemaName)).toEqual(later(before.physical).map(input => input.schemaName));
  expect(() => stepEfficiencyAlgorithmRef({ planningPartition: "balanced-two-v1" })).toThrow("reviewed shared transport");
});

it("does not commit a successful planning sibling when the other physical request fails", async () => {
  const failed = await run(true, true);
  expect(failed.physical.filter(input => input.schemaName === "truth_resolution_plan_commit")).toHaveLength(2);
  expect(failed.physical.some(input => input.role === "observation-renderer")).toBe(false);
});
