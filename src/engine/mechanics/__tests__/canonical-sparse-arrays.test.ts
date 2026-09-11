import { expect, it } from "vitest";
import { runConditionalCompletionScenario } from "../../benchmarks/step-efficiency/conditional-scenario";
import { evaluateCommittedBehaviorOracle } from "../../benchmarks/step-efficiency/behavior-oracle";
import { transitionProposalSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { promptBundle } from "../../prompts";
import { logicalRepairContext } from "../../prompts/logical-repair-context";
import { replaySimulationState } from "../../runtime/transaction";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { TEST_WORLD_HASH } from "../../testing/world";
import { canonicalSparseArraysRequest, decodeSparseTransitionArrays, encodeSparseTransitionArrays } from "../canonical-sparse-arrays";
import { canonicalTransitionEvidenceRequest } from "../transition-evidence-worklist";
import { indexedReviewedPlanningProvider } from "../indexed-reviewed-planning-pipeline";

const causes = [{ kind: "action", ref: "ref:action:a" }];
const assertions = [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }];
const canonical = {
  outcomes: [{ proposalKey: "arrival", actionRef: "ref:action:a", status: "succeeded", summary: "Arrived at the gate", causes, assertions }],
  operations: [{ kind: "place_entity", entityRef: "ref:entity:player", placementRef: "ref:placement:gate", causes, assertions }],
  events: [], mechanicInvocations: [], decisionRequests: [],
};

it("round trips empty and nonempty categories without supplying outcomes or nested values", () => {
  for (const value of [canonical, { ...canonical, operations: [] }, {
    ...canonical, mechanicInvocations: [{ input: { nested: [2, 1] } }], events: [{ description: "preserve" }], decisionRequests: [{ payload: [false, null] }],
  }]) {
    const before = contentHash(value), wire = encodeSparseTransitionArrays(value);
    expect(decodeSparseTransitionArrays(wire)).toEqual(value);
    expect(contentHash(value)).toBe(before);
  }
  expect(transitionProposalSchema.safeParse(decodeSparseTransitionArrays(encodeSparseTransitionArrays(canonical))).success).toBe(true);
  for (const invalid of [{}, { ...canonical, extra: true }, { ...canonical, outcomes: [{ status: "succeeded" }] },
    { ...canonical, operations: [{}] }]) expect(transitionProposalSchema.safeParse(decodeSparseTransitionArrays(invalid)).success).toBe(false);
  for (const value of [null, [], { ...canonical, operations: null }, { ...canonical, events: "missing" }]) {
    expect(() => decodeSparseTransitionArrays(value)).toThrow();
  }
});

it.each([false, true])("declares omission at the actual gateway and preserves complete context and repair binding (repair=%s)", async repair => {
  const baseline = createTestModelCatalog(["truth-deepseek"]), profile = baseline.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: baseline.scheduler, registry: baseline.registry,
    accounts: baseline.accounts, model_overrides: {}, profiles: { "truth-deepseek": {
      ...profile, inference: { ...profile.inference, thinking: "disabled" },
    } } });
  const action = { actionRef: "ref:action:a", rawText: "Walk to the gate; keep the delivery for later.", goal: "Reach gate" };
  const plan = { actionRef: action.actionRef, actorRef: "ref:entity:player", targetRefs: [], causes: [] };
  const source = { task: { stage: "transition", constraints: [] }, state: { actionSet: { assigned: [action] },
    committedResolutionPlans: [plan], resolutionReceipts: [{ plan }], temporalExecution: { activities: {} },
    canonicalTruth: { facts: {}, entities: { "ref:entity:player": { placementRef: null } }, placements: {} } }, repair: null };
  const context = repair ? logicalRepairContext(source, { attempt: 1, scope: "step", targetIds: [], issues: [], previousOutput: canonical }, contentHash(source), "truth_transition") : source;
  const prompt = promptBundle("truth-transition");
  const request = { ...prompt, promptVersion: prompt.version, role: "truth-transition" as const, profileId: "truth-deepseek",
    workloadId: "sparse-fixture", batchId: "original", subjectId: "source", runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 },
    context, schemaName: "truth_transition", schema: transitionProposalSchema };
  const original = canonicalTransitionEvidenceRequest(request);
  const selected = canonicalSparseArraysRequest(original), wire = encodeSparseTransitionArrays(canonical);
  expect(selected.context).toBe(original.context);
  expect(selected.schema).toBe(original.schema);
  expect(selected.system).toBe(original.system);
  expect((selected.context as { repair: unknown }).repair).toEqual((context as { repair: unknown }).repair);
  expect(() => canonicalSparseArraysRequest(selected)).toThrow("exactly once");
  const other = { ...original, schemaName: "truth_transition_batch" };
  expect(canonicalSparseArraysRequest(other)).toBe(other);
  const expectedSchema = structuredClone(original.wireJsonSchema) as { required: string[] };
  expectedSchema.required = ["outcomes"];
  expect(selected.wireJsonSchema).toEqual(expectedSchema);
  const bodies: Array<Record<string, unknown>> = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      expect(body.thinking).toEqual({ type: "disabled" });
      return new Response(JSON.stringify({ id: "sparse", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(wire) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  await expect(gateway.generateStructured(original)).rejects.toThrow("schema validation");
  expect((await indexedReviewedPlanningProvider(gateway).generateStructured(request)).value).toEqual(canonical);
  expect(bodies).toHaveLength(2);
  expect({ ...bodies[1], messages: null }).toEqual({ ...bodies[0], messages: null });
});

it.each([false, true])("checks actual committed movement with an independent behavior oracle after decoding (omit movement=%s)", async omitMovement => {
  let calls = 0;
  const run = runConditionalCompletionScenario("arrived", async (_request, fallback) => {
    calls++;
    const generated = await fallback();
    const wire = encodeSparseTransitionArrays(generated.value as Record<string, unknown>);
    if (omitMovement) delete wire.operations;
    return { ...generated, value: decodeSparseTransitionArrays(wire) as typeof generated.value };
  });
  const { source, result, action, oracle } = await run;
  expect(calls).toBeGreaterThan(0);
  // Surrounding semantic roles are scripted; a successful commit is insufficient.
  const verdict = evaluateCommittedBehaviorOracle({ source, checkpoint: result.state, action, oracle });
  expect(verdict.verdict).toBe(omitMovement ? "failed" : "passed");
  expect(result.state.truth.placements.player).toBe(omitMovement ? "courtyard" : "gate");
  if (omitMovement) expect(verdict.issues).toContain("independent postcondition failed: placement_equals");
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
