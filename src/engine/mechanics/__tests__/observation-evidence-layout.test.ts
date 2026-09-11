import { expect, it } from "vitest";
import { z } from "zod";
import { observationRenderSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import type { StructuredModelRequest } from "../../models/model-provider";
import { promptBundle } from "../../prompts";
import { createTestModelCatalog, createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { OBSERVATION_EVIDENCE_LAYOUT, observationEvidenceProvider, observationEvidenceRequest } from "../observation-evidence-layout";
import { expandSharedBatchContexts, type SharedBatchContext } from "../shared-batch-context";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";

const draft = { sourceEventRefs: [], introductions: [], apparentClaims: [], summary: "No new result is confirmed." };
function request(id: string): StructuredModelRequest<unknown> {
  const prompt = promptBundle("observation-renderer");
  return { profileId: "truth-deepseek", role: "observation-renderer", subjectId: id,
    workloadId: "instance", batchId: "step", schemaName: "observation_render", schema: observationRenderSchema,
    system: prompt.system, userPrompt: prompt.userPrompt, promptVersion: prompt.version,
    runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 },
    context: { contractVersion: 17, roleContract: { role: "observation-renderer" },
      execution: { worldId: "world", instanceId: "instance", advanceId: "step", revision: 0, step: 0 },
      task: { assignment: { targetHandles: [`ref:agent:${id}`], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
      state: { observationSlots: [{ observer: { agentRef: `ref:agent:${id}`, selfEntityRef: `ref:entity:${id}`,
        localEntities: [{ ref: `ref:local_entity:${id}::self`, canonicalEntityRefs: [`ref:entity:${id}`] }] } }],
        actionSet: { assigned: [{ actionRef: `ref:action:${id}`, actorRef: `ref:agent:${id}`, rawText: "Try the complete compound action, only if its condition holds.",
          constraints: [{ full: ["condition", "recipient", "quantity"] }] }, { actionRef: "ref:action:other", actorRef: "ref:agent:other", rawText: "Another actor's complete action." }] },
        outcomes: [{ actionRef: `ref:action:${id}`, status: "continuing", summary: "Still pending." }], currentEvents: [],
        canonicalTruth: { facts: ["Complete source context remains present."] } },
      referenceCatalog: { version: 2, hash: "test", candidates: [] }, repair: null } };
}

it("preserves canonical schema and values while placing evidence first for a single observer", () => {
  const source = request("one"), before = contentHash(source.context), next = observationEvidenceRequest(source);
  expect(next.context).toBe(source.context);
  expect(contentHash(source.context)).toBe(before);
  expect(next.schema).toBe(source.schema);
  expect(contentHash(next.wireJsonSchema)).toBe(contentHash(z.toJSONSchema(source.schema, { target: "draft-07" })));
  expect(Object.keys(next.wireJsonSchema!.properties as object)).toEqual(["sourceEventRefs", "introductions", "apparentClaims", "summary"]);
  expect(next.schema.parse(draft)).toEqual(source.schema.parse(draft));
  expect(next.system).toBe(source.system); expect(next.userPrompt).toBe(source.userPrompt);
  expect(next.jsonObjectPostlude).toContain("Try the complete compound action, only if its condition holds.");
  expect(next.jsonObjectPostlude).toContain('"constraints":[{"full":["condition","recipient","quantity"]}]');
  expect(next.jsonObjectPostlude).toContain('"status":"continuing"');
  expect(next.promptVersion).toContain(OBSERVATION_EVIDENCE_LAYOUT);
  expect(() => observationEvidenceRequest(next)).toThrow("already applied");
  expect(() => observationEvidenceRequest({ ...source, system: "changed" })).toThrow("contract changed");
  expect(() => observationEvidenceRequest({ ...source, wireJsonSchema: { type: "object", properties: {} } })).toThrow("unexpected observation schema");
  expect(observationEvidenceRequest({ ...source, role: "truth-resolution" }).jsonObjectPostlude).toBeUndefined();
});

it.each([false, true])("binds complete physical observation slots and scoped repair evidence (%s)", repair => {
  return (async () => {
    const inputs = [request("one"), request("two")], physical: StructuredModelRequest<unknown>[] = [];
    const events = [{ id: "ref:event:shared", description: "Full event text; inclusion does not establish access.", causes: [{ kind: "action", ref: "ref:action:other" }] }];
    (inputs[1]!.context as { state: { currentEvents: unknown[] } }).state.currentEvents = events;
    if (repair) for (const input of inputs) (input.context as Record<string, unknown>).repair = { issues: [{ code: "invalid_observation", message: "Keep this observer's full evidence." }] };
    const fake = new ScriptedModelProvider(() => ({ slots: [0, 1].map(slot => ({ slot, result: draft })) }), createTestModelCatalog(["truth-deepseek"]), false);
    const generate = fake.generateStructured.bind(fake);
    fake.generateStructured = input => { physical.push(input); return generate(input); };
    const coordinator = new TruthBatchCoordinator(observationEvidenceProvider(fake), 12, 0, "shared-json-v2", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(physical).toHaveLength(1); expect(results.map(r => r.value)).toEqual([draft, draft]);
    const observed = physical[0]!;
    expect(expandSharedBatchContexts((observed.context as { state: SharedBatchContext }).state)).toEqual(inputs.map(input => input.context));
    const wire = observed.wireJsonSchema as { properties: { slots: { items: { properties: { result: { properties: object } } } } } };
    expect(Object.keys(wire.properties.slots.items.properties.result.properties)).toEqual(["sourceEventRefs", "introductions", "apparentClaims", "summary"]);
    expect(observed.jsonObjectPostlude).toContain('"slot":1');
    const evidenceText = observed.jsonObjectPostlude!.split("Exact evidence copies, without inference or added access:\n")[1]!.split("\n\nReturn sourceEventRefs")[0]!;
    const evidence = JSON.parse(evidenceText) as Array<{ currentEvents: unknown[] }>;
    expect(evidence.map(entry => entry.currentEvents)).toEqual([[], events]);
    const altered = structuredClone(observed.context) as { task: { slots: Array<{ observerBinding: unknown }> } };
    altered.task.slots[0]!.observerBinding = altered.task.slots[1]!.observerBinding;
    expect(() => observationEvidenceRequest({ ...observed, context: altered, jsonObjectPostlude: undefined, promptVersion: inputs[0]!.promptVersion })).toThrow("binding differs");
  })();
});

it("sends the reordered schema and accounted appendix through the actual JSON HTTP adapter", async () => {
  const source = request("one"), candidate = observationEvidenceRequest(source), catalog = createTestModelCatalog(["truth-deepseek"]);
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "observation-layout-test", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(draft) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const baseline = await gateway.generateStructured(source), changed = await gateway.generateStructured(candidate);
  expect(changed.value).toEqual(baseline.value);
  const message = bodies[1]!.messages[1]!.content;
  expect(message).toContain('JSON Schema: '+JSON.stringify(candidate.wireJsonSchema));
  expect(message.endsWith(candidate.jsonObjectPostlude!)).toBe(true);
  expect(message.indexOf(candidate.jsonObjectPostlude!)).toBeGreaterThan(message.indexOf("JSON Schema:"));
  expect(bodies[1]!.messages[0]).toEqual(bodies[0]!.messages[0]);
  expect(changed.audit.invocations[0]!.requestUtf8Bytes).toBeGreaterThan(baseline.audit.invocations[0]!.requestUtf8Bytes);
  expect(changed.audit.invocations[0]!.requestHash).not.toBe(baseline.audit.invocations[0]!.requestHash);
  await expect(gateway.generateStructured({ ...candidate, structuredOutputMode: "json-schema-strict" })).rejects.toThrow();
  expect(bodies).toHaveLength(2);
});

it("pins the layout in the experimental game Composition without selecting it by default", () => {
  const registry = registerBuiltinAlgorithms();
  const baseline = stepEfficiencyAlgorithmRef({ sourceBoundObservations: true });
  const candidate = stepEfficiencyAlgorithmRef({ sourceBoundObservations: true, observationEvidenceLayout: true });
  expect(registry.has(candidate)).toBe(true);
  expect(candidate.children.observationRendering!.config.evidenceLayout).toBe(OBSERVATION_EVIDENCE_LAYOUT);
  expect(baseline.children.observationRendering!.config.evidenceLayout).toBeUndefined();
  expect(candidate.manifestHash).not.toBe(baseline.manifestHash);
  expect(() => stepEfficiencyAlgorithmRef({ observationEvidenceLayout: true })).toThrow("source-bound observation rendering");
});
