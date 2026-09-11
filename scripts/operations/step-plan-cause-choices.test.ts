import path from "node:path";
import { expect, it } from "vitest";
import { stepEfficiencyAlgorithmRef } from "./step-efficiency-playtest";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { orderedRandomAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { INDEXED_REVIEWED_PLANNING_PIPELINE } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { SOURCE_INDEXED_PLAN_CAUSES } from "../../src/engine/mechanics/source-indexed-plan-causes";
import { PLANNING_CONTRACT_TAIL } from "../../src/engine/mechanics/planning-contract-tail";
import { SOURCE_INDEXED_PLAN_MEANS } from "../../src/engine/mechanics/source-indexed-planning";
import { RESOLUTION_FACT_EVIDENCE } from "../../src/engine/contracts/resolution-source-inventory";
import { expandSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";

it.each([{ means: false, facts: false }, { means: true, facts: false }, { means: true, facts: true }])("reaches source selection through the registered game-step entry (%j)", async ({ means, facts }) => {
  const selected = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1",
    truthTransport: "shared-state-first-v1", truthFlushBoundary: "post-promise-v1",
    planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE, planCauseChoices: true, ...(means ? { planMeansChoices: true } : {}),
    ...(facts ? { planFactEvidence: true, planningContractTail: true } : {}) });
  const base = orderedRandomAlgorithmRef(FULL_CATALOG_ALGORITHM_REF);
  const composition = defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution: selected.children.truthResolution! } });
  let factIds: string[] = [];
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
      compilation.interactionDependency = deterministicInteractionDependency({ reads: factIds.map(id => ({ kind: "fact", id })), writes: [{ kind: "entity", id: action.actorId }],
        audienceAgentIds: [action.actorId], sharedResourceClaims: [] });
    });
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const seen: StructuredModelRequest<unknown>[] = [], generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async request => {
    if (request.role === "truth-resolution" && request.schemaName.startsWith("truth_resolution_plan")) {
      seen.push(request);
      throw new ModelConfigurationError("stop at the physical planning boundary");
    }
    return generate(request);
  };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 49, modelCatalog: provider.catalog });
  if (facts) factIds = Object.keys(definition.initialState.truth.facts);
  const engine = new SimulationEngine(definition, registerBuiltinAlgorithms().create(composition, { provider }));
  await engine.bootstrapAgents(); const source = engine.snapshot;
  await expect(engine.step(Object.fromEntries(Object.keys(source.agents).map(agentId => [agentId,
    { kind: "external" as const, agentId, participantId: `test-${agentId}` }])), {
    expectedRevision: source.revision, trigger: "participant_action", externalActions: Object.keys(source.agents).map(agentId => ({
      submissionId: `action-${agentId}`, agentId, rawText: "Remain here and look around.", goal: "Observe my surroundings", means: null, targetIds: [],
    })),
  })).rejects.toThrow();
  expect(seen.length).toBeGreaterThan(0);
  for (const request of seen) {
    expect(request.promptVersion).toContain(SOURCE_INDEXED_PLAN_CAUSES);
    expect(JSON.stringify(request.wireJsonSchema)).toContain('"causeIndices"');
    const context = request.context as { task: { planCauseChoices: { contract: string; choices: unknown[] } } };
    expect(context.task.planCauseChoices.contract).toBe(SOURCE_INDEXED_PLAN_CAUSES);
    expect(context.task.planCauseChoices.choices.length).toBeGreaterThan(0);
    if (means) {
      expect(request.promptVersion).toContain(SOURCE_INDEXED_PLAN_MEANS);
      expect(JSON.stringify(request.wireJsonSchema)).toContain('"sourcePosition"');
    }
    if (facts) {
      expect(request.promptVersion).toContain(PLANNING_CONTRACT_TAIL);
      expect(request.jsonObjectPostlude).toContain("requiredActionIndices");
      const source = request.context as { state: Parameters<typeof expandSharedBatchContexts>[0]; task: {
        planningWorklist: { actions: Array<{ slot: number; action: { allowedMeansSources: Array<{
          kind: string; ref: string; factEvidence?: { recordHash: string; record: unknown };
        }> } }> };
      } };
      const slots = expandSharedBatchContexts(source.state) as Array<{ task: { planFactEvidence: { contract: string; factSnapshotHash: string } }; state: { canonicalTruth: { facts: Record<string, unknown> } } }>;
      for (const slot of slots) expect(slot.task.planFactEvidence).toEqual({ contract: RESOLUTION_FACT_EVIDENCE,
        factSnapshotHash: contentHash(slot.state.canonicalTruth.facts) });
      const evidence = source.task.planningWorklist.actions.flatMap(row => row.action.allowedMeansSources.filter(s => s.kind === "fact").map(s => ({ ...s, slot: row.slot })));
      expect(evidence.length).toBeGreaterThan(0);
      for (const entry of evidence) {
        const record = slots[entry.slot]!.state.canonicalTruth.facts[entry.ref];
        expect(entry.factEvidence!.record).toEqual(record);
        expect(entry.factEvidence!.recordHash).toBe(contentHash(record));
      }
    } else expect(JSON.stringify(request.context)).not.toContain('"factEvidence"');
  }
  expect(engine.snapshot.truth).toEqual(source.truth);
  expect(() => stepEfficiencyAlgorithmRef({ planMeansChoices: true })).toThrow("indexed reviewed");
  expect(() => stepEfficiencyAlgorithmRef({ planFactEvidence: true })).toThrow("indexed reviewed");
  expect(() => stepEfficiencyAlgorithmRef({ planningContractTail: true })).toThrow("indexed causes and means");
});
