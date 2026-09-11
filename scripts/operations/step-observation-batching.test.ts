import path from "node:path";
import { expect, it } from "vitest";
import { stepEfficiencyAlgorithmRef } from "./step-efficiency-playtest";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { contentHash } from "../../src/engine/models/model-audit";
import type { StructuredModelRequest } from "../../src/engine/models/model-provider";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";
import { TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";

it("pins the prospective observation contract without changing other roles or accepting unshared contexts", () => {
  const before = stepEfficiencyAlgorithmRef(), after = stepEfficiencyAlgorithmRef({ observationRepairBatching: true });
  expect(registerBuiltinAlgorithms().has(after)).toBe(true);
  const oldObservation = before.children.observationRendering!, observation = after.children.observationRendering!;
  expect(after).toEqual(defineAlgorithmRef({ ...before, children: { ...before.children, observationRendering: observation } }));
  expect(observation).toEqual(defineAlgorithmRef({ ...oldObservation, children: { ...oldObservation.children,
    batching: defineAlgorithmRef({ ...oldObservation.children.batching!, config: { ...oldObservation.children.batching!.config,
      requestContract: TRUTH_BATCH_REQUEST_CONTRACT, repairPlacement: "tail-v1" } }),
  } }));
  expect(() => stepEfficiencyAlgorithmRef({ directTruthContext: true, observationRepairBatching: true })).toThrow("shared observation context codec");
});

async function run(observationRepairBatching: boolean) {
  const selected = stepEfficiencyAlgorithmRef(observationRepairBatching ? { observationRepairBatching: true } : undefined);
  // Exercise the exact selected observation child through the registered step
  // while deterministic full-catalog siblings isolate this transport change.
  const composition = defineAlgorithmRef({ ...FULL_CATALOG_ALGORITHM_REF, children: {
    ...FULL_CATALOG_ALGORITHM_REF.children, observationRendering: selected.children.observationRendering!,
  } });
  let reviews = 0;
  const provider = new ScriptedModelProvider(({ role, schemaName, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
      compilation.interactionDependency = deterministicInteractionDependency({ reads: [], writes: [{ kind: "entity", id: action.actorId }],
        audienceAgentIds: [action.actorId], sharedResourceClaims: [] });
    });
    if (schemaName === "causal_verification" && ++reviews === 1) {
      const candidate = (context as { state: { candidate: { observations: Array<{ observationRef: string }> } } }).state.candidate;
      expect(candidate.observations).toHaveLength(2);
      return { verdict: "reject", findings: candidate.observations.map((observation, index) => ({
        target: { kind: "observation", targetHandle: observation.observationRef }, evidenceHandles: [],
        code: "observation-mismatch", message: `Unsupported result for observer slot ${index}.`,
        repairHint: `Repair only observer slot ${index} using its actual evidence.`,
      })) };
    }
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const physical: StructuredModelRequest<unknown>[] = [];
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => { physical.push(request); return generate(request); };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, registerBuiltinAlgorithms().create(composition, { provider }));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step(Object.fromEntries(Object.keys(source.agents).map(agentId => [agentId,
    { kind: "external" as const, agentId, participantId: `test-${agentId}` }])), {
    expectedRevision: source.revision, trigger: "participant_action", externalActions: Object.keys(source.agents).map(agentId => ({
      submissionId: `action-${agentId}`, agentId, rawText: "Remain here and look around.", goal: "Observe my surroundings", means: null, targetIds: [],
    })),
  });
  const observations = physical.filter(request => request.role === "observation-renderer");
  const contexts = observations.flatMap(request => {
    const shared = (request.context as { state?: unknown }).state;
    return isSharedBatchContext(shared) ? expandSharedBatchContexts(shared) : [request.context];
  });
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  return { result, physical, observations, contexts, reviews };
}

it("coalesces different final-observer repairs through the selected registered component without changing logical input or effects", async () => {
  const before = await run(false), after = await run(true);
  expect(before.observations).toHaveLength(3);
  expect(after.observations).toHaveLength(2);
  expect(after.observations[1]!.schemaName).toBe("observation_projection_batch");
  expect(after.observations[1]!.jsonExamplePolicy).toBe("omit");
  expect(after.contexts).toEqual(before.contexts);
  const repairs = after.contexts.filter(context => (context as { repair?: unknown }).repair) as Array<{
    repair: { target: string; issues: Array<{ reason: string }> };
    state: { observationSlots: Array<{ observer: { agentRef: string } }> };
  }>;
  expect(repairs).toHaveLength(2);
  expect(new Set(repairs.map(context => context.repair.target)).size).toBe(2);
  for (const context of repairs) expect(context.repair.target).toBe(context.state.observationSlots[0]!.observer.agentRef);
  expect(new Set(repairs.map(context => context.repair.issues[0]!.reason)).size).toBe(2);
  expect(after.reviews).toBe(2);
  expect(after.physical.length).toBe(before.physical.length - 1);
  expect(after.result.state.truth).toEqual(before.result.state.truth);
  expect(after.result.state.agents).toEqual(before.result.state.agents);
  expect(after.result.committed.observations).toEqual(before.result.committed.observations);
});
