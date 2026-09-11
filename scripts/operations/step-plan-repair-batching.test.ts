import path from "node:path";
import { expect, it } from "vitest";
import { stepEfficiencyAlgorithmRef } from "./step-efficiency-playtest";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { orderedRandomAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import type { StructuredModelRequest } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";

type Context = { task: { resolutionScope?: { mode: string } }; state: {
  candidateResolutionPlans?: Array<{ planRef: string; actionRef: string }>;
  committedResolutionPlans?: unknown[];
} };
const slots = (context: unknown): Context[] => {
  const state = (context as { state: unknown }).state;
  return (isSharedBatchContext(state) ? expandSharedBatchContexts(state) : [context]) as Context[];
};

async function run(enabled: boolean) {
  const selected = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1",
    truthTransport: "shared-state-first-v1", truthFlushBoundary: "post-promise-v1",
    ...(enabled ? { planRepairBatching: "scoped-plans-v1" } : {}) });
  expect(registerBuiltinAlgorithms().has(selected)).toBe(true);
  const base = orderedRandomAlgorithmRef(FULL_CATALOG_ALGORITHM_REF), original = base.children.truthResolution!;
  const composition = defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution: defineAlgorithmRef({ ...original,
    children: { ...original.children, batching: selected.children.truthResolution!.children.batching! } }) } });
  const seen = new Set<string>();
  const provider = new ScriptedModelProvider(({ role, schemaName, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
      compilation.interactionDependency = deterministicInteractionDependency({ reads: [], writes: [{ kind: "entity", id: action.actorId }],
        audienceAgentIds: [action.actorId], sharedResourceClaims: [] });
    });
    if (schemaName.startsWith("resolution_plan_verification")) {
      const reviews = slots(context).map(c => {
        const findings = c.state.candidateResolutionPlans!.flatMap(p => {
          if (seen.has(p.actionRef)) return [];
          seen.add(p.actionRef);
          return [{ planRef: p.planRef, code: "ungrounded-mean", message: "Recheck this action's means against its source.",
            repairHint: "Retain its own complete action and return only its scoped plan." }];
        });
        return findings.length ? { verdict: "reject", findings } : { verdict: "accept", findings: [] };
      });
      return schemaName.endsWith("_batch") ? { slots: reviews.map((result, slot) => ({ slot, result })) } : reviews[0];
    }
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    if (role === "truth-resolution" && slots(context).every(c => c.task.resolutionScope?.mode === "repair")) {
      // Only the model boundary is substituted. Actual repair source contexts
      // remain untouched and are compared below after canonical expansion.
      const plans = slots(context).map(c => deterministicModelOutput(profileId,
        { ...c, state: { ...c.state, committedResolutionPlans: [] } }));
      return schemaName.endsWith("_batch") ? { slots: plans.map((result, slot) => ({ slot, result })) } : plans[0];
    }
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const physical: StructuredModelRequest<unknown>[] = [], generate = provider.generateStructured.bind(provider);
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
  const repairs = physical.filter(r => r.role === "truth-resolution" && slots(r.context).every(c => c.task.resolutionScope?.mode === "repair"));
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  return { repairs, contexts: repairs.flatMap(r => slots(r.context)), result };
}

it("batches actual semantic plan repairs through the selected registry child without changing their world effects", async () => {
  const before = await run(false), after = await run(true);
  expect(before.repairs).toHaveLength(2);
  expect(after.repairs).toHaveLength(1);
  expect(before.repairs.map(r => r.schemaName)).toEqual(["truth_resolution_plan_repair", "truth_resolution_plan_repair"]);
  expect(after.repairs[0]!.schemaName).toBe("truth_resolution_plan_commit_batch");
  const ordered = (contexts: unknown[]) => [...contexts].sort((a, b) => contentHash(a).localeCompare(contentHash(b)));
  expect(ordered(after.contexts)).toEqual(ordered(before.contexts));
  expect(after.result.state.truth).toEqual(before.result.state.truth);
  expect(after.result.state.agents).toEqual(before.result.state.agents);
  expect(after.result.committed.observations).toEqual(before.result.committed.observations);
  expect(() => stepEfficiencyAlgorithmRef({ planRepairBatching: "scoped-plans-v1" })).toThrow("reviewed shared transport");
});
