import { expect, it, vi } from "vitest";
import { modelCausalAssertionSchema, truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { TEST_WORLD_HASH } from "../../testing/world";
import { promptBundle } from "../../prompts";
import { SourceIndexedTransitionCodec, indexedTransitionRequest } from "../source-indexed-transition";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { bindTruthBatchCardinality, SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";

function fixture() {
  const assigned = [["ref:action:a", "ref:action:b"], ["ref:action:c"]];
  const contexts = assigned.map(refs => ({ state: { actionSet: { assigned: refs.map(actionRef => ({ actionRef,
    rawText: "等待同伴到达后交付两袋粮食；若桥断则原地保管，不告知对岸。", goal: "Conditional delivery with quantity and audience intact" })) },
    canonicalTruth: { elapsedSeconds: 0, hiddenFacts: { secret: "retain exact source" } } },
  referenceCatalog: { candidates: refs.map(handle => ({ handle, allowedUses: ["cause"] })) }, repair: null }));
  const context = { task: { slots: [{ slot: 0 }, { slot: 1 }] }, state: factorSharedBatchContexts(contexts, "shared-json-v3") };
  const result = { slots: [1, 0].map(slot => ({ slot, result: {
    outcomes: assigned[slot]!.map(actionRef => ({ proposalKey: `outcome-${actionRef.at(-1)}`, actionRef, status: "continuing" as const,
      summary: "等待条件；尚未交付。", causes: [{ kind: "action" as const, ref: actionRef }],
      assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: 10 }] })),
    operations: slot === 0 ? [{ kind: "place_entity" as const, entityRef: "ref:entity:cargo", placementRef: "ref:entity:store",
      causes: [{ kind: "action" as const, ref: "ref:action:a" }], assertions: [{ kind: "placement_equals" as const,
        entityRef: "ref:entity:cargo", placementRef: "ref:entity:bridge" }] }] : [],
    mechanicInvocations: [], decisionRequests: [],
    events: [{ proposalKey: `event-${slot}`, description: "Goods remain guarded", impact: "ordinary" as const,
      causes: [{ kind: "action" as const, ref: assigned[slot]![0]! }],
      assertions: [{ kind: "fact_matches" as const, factRef: "ref:fact:quantity", expected: { kind: "number" as const, value: 2 } }] }],
  } })) };
  return { context, result };
}

it("round trips all semantic fields, source ownership, typed evidence and declared row order", () => {
  const { context, result } = fixture(), codec = new SourceIndexedTransitionCodec(context);
  const before = contentHash(context), wire = codec.encode(result);
  expect((wire.outcomes as Record<string, unknown>[])[0]).not.toHaveProperty("assertions");
  expect((wire.outcomes as Record<string, unknown>[])[0]).toHaveProperty("firstAssertion.kind", "elapsed_seconds_compare");
  expect((wire.outcomes as Record<string, unknown>[])[0]).toHaveProperty("additionalAssertions", []);
  expect(wire.slots).toEqual([1, 0]);
  expect((wire.outcomes as Array<{ actionIndex: number }>).map(row => row.actionIndex)).toEqual([2, 0, 1]);
  expect(codec.decode(wire)).toEqual(result);
  expect(codec.encode(codec.decode(wire))).toEqual(wire);
  expect(contentHash(context)).toBe(before);
  const expanded = codec.context(context);
  delete (expanded.task as Record<string, unknown>).transitionWorklist;
  expect(expanded).toEqual(context);
  expect(() => codec.context({ ...context, injected: true })).toThrow("snapshot changed");
});

it("rejects missing fields, lost or duplicated actions, foreign identity and stale source bindings", () => {
  const { context, result } = fixture(), codec = new SourceIndexedTransitionCodec(context);
  const mutations = [
    (value: Record<string, unknown>) => { delete value.operations; },
    (value: Record<string, unknown>) => { value.outcomes = []; },
    (value: Record<string, unknown>) => { (value.outcomes as unknown[]).pop(); },
    (value: Record<string, unknown>) => { (value.outcomes as unknown[]).push((value.outcomes as unknown[])[0]); },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.actionIndex = -1; },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.actionRef = "ref:action:a"; },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.slot = 1; },
    (value: Record<string, unknown>) => { (value.operations as Record<string, unknown>[])[0]!.slot = 2; },
    (value: Record<string, unknown>) => { delete (value.outcomes as Record<string, unknown>[])[0]!.status; },
    (value: Record<string, unknown>) => { delete (value.outcomes as Record<string, unknown>[])[0]!.firstAssertion; },
    (value: Record<string, unknown>) => { delete (value.outcomes as Record<string, unknown>[])[0]!.additionalAssertions; },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.firstAssertion = null; },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.additionalAssertions = {}; },
    (value: Record<string, unknown>) => { (value.outcomes as Record<string, unknown>[])[0]!.assertions = []; },
  ];
  for (const mutate of mutations) { const wire = codec.encode(result); mutate(wire); expect(() => truthTransitionBatchSchema.parse(codec.decode(wire))).toThrow(); }
  const foreign = structuredClone(result); foreign.slots[0]!.result.outcomes[0]!.actionRef = "ref:action:a";
  expect(() => codec.encode(foreign)).toThrow("foreign action ownership");
  const forged = structuredClone(context); forged.state.slots[0]!.contextHash = "tampered";
  expect(() => new SourceIndexedTransitionCodec(forged)).toThrow();
});

it("preserves multiple typed outcome assertions and their ordering without supplying witnesses", () => {
  const { context, result } = fixture(), codec = new SourceIndexedTransitionCodec(context);
  const canonical = truthTransitionBatchSchema.parse(result);
  canonical.slots[0]!.result.outcomes[0]!.assertions.push(
    modelCausalAssertionSchema.parse({ kind: "quantity_compare", quantityRef: "ref:quantity:grain", operator: "eq", value: 2 }),
    modelCausalAssertionSchema.parse({ kind: "placement_equals", entityRef: "ref:entity:cargo", placementRef: "ref:entity:store" }));
  const wire = codec.encode(canonical);
  expect((wire.outcomes as Record<string, unknown>[])[0]!.additionalAssertions).toEqual(canonical.slots[0]!.result.outcomes[0]!.assertions.slice(1));
  expect(codec.decode(wire)).toEqual(canonical);
});

it("adapts only the physical transition boundary and retains canonical parsing and downstream processing", () => {
  const { context, result } = fixture(), bundle = promptBundle("truth-transition");
  const preprocessOutput = vi.fn((value: unknown) => ({ value, symbolRepairs: [] }));
  const request: StructuredModelRequest<unknown> = { ...bundle, role: "truth-transition", profileId: "nonthinking-flash",
    workloadId: "work", batchId: "batch", subjectId: "subject", promptVersion: bundle.version,
    userPrompt: bundle.userPrompt + "\n\n" + SHARED_SLOT_RESULT_INSTRUCTION,
    schemaName: "truth_transition_batch", schema: bindTruthBatchCardinality(truthTransitionBatchSchema, 2), context,
    jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1", preprocessOutput };
  const adapted = indexedTransitionRequest(request), codec = new SourceIndexedTransitionCodec(context);
  expect(adapted.schema).toBe(request.schema);
  expect(adapted.system).toBe(request.system);
  expect(adapted.profileId).toBe(request.profileId);
  expect(adapted.contextLayout).toBe(request.contextLayout);
  expect(adapted.jsonSyntaxRecovery).toBe(request.jsonSyntaxRecovery);
  expect(adapted.preprocessOutput!(codec.encode(result)).value).toEqual(result);
  expect(preprocessOutput).toHaveBeenCalledExactlyOnceWith(result);
  expect(adapted.schema.parse(adapted.preprocessOutput!(codec.encode(result)).value)).toEqual(result);
  expect(() => indexedTransitionRequest(adapted)).toThrow("contract drift");
  const singleton = { ...request, schemaName: "truth_transition" };
  expect(indexedTransitionRequest(singleton)).toBe(singleton);
});

it("sends the complete indexed wire through the actual gateway and parses it back with runtime identity", async () => {
  const { context, result } = fixture(), codec = new SourceIndexedTransitionCodec(context), bundle = promptBundle("truth-transition");
  const baseline = createTestModelCatalog(["truth-deepseek"]), profile = baseline.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: baseline.scheduler, registry: baseline.registry,
    accounts: baseline.accounts, model_overrides: {}, profiles: { "truth-deepseek": { ...profile, inference: { ...profile.inference, thinking: "disabled" } } } });
  let calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.messages[1].content).toContain("transitionWorklist");
      return new Response(JSON.stringify({ id: "test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(codec.encode(result)) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const request: StructuredModelRequest<unknown> = { ...bundle, role: "truth-transition", profileId: "truth-deepseek",
    workloadId: "qualification", batchId: "first", subjectId: "original-batch", promptVersion: bundle.version,
    runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 },
    userPrompt: bundle.userPrompt + "\n\n" + SHARED_SLOT_RESULT_INSTRUCTION,
    schemaName: "truth_transition_batch", schema: bindTruthBatchCardinality(truthTransitionBatchSchema, 2), context };
  expect((await gateway.generateStructured(indexedTransitionRequest(request))).value).toEqual(result);
  expect(calls).toBe(1);
});
