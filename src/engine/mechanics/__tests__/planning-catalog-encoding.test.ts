import { expect, it } from "vitest";
import { resolutionContinuationDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import type { StructuredModelRequest } from "../../models/model-provider";
import { promptBundle } from "../../prompts";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { expandRepairDiagnosticDomains } from "../repair-diagnostic-domains";
import { expandSharedBatchContexts } from "../shared-batch-context";
import { expandSharedCatalogPrefix } from "../shared-catalog-prefix";
import { expandSharedCatalogRecords } from "../shared-catalog-records";
import { planningCatalogEncodingProvider, planningCatalogEncodingRequest, PLANNING_CATALOG_ENCODING } from "../planning-catalog-encoding";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { recordedContext } from "../../benchmarks/step-efficiency/repair-tail";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { INDEXED_REVIEWED_PLANNING_PIPELINE } from "../indexed-reviewed-planning-pipeline";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC } from "../resolution-dependent-fields-codec";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../../prompts/repair-layout";

function request(slot: number, repair: boolean): StructuredModelRequest<unknown> {
  const prompt = promptBundle("truth-resolution");
  const rejectedDomain = Array.from({ length: 24 }, (_, index) => ({ kind: "fact", ref: `ref:fact:old-${index}`,
    label: `Complete old evidence ${index}`, slots: [4, 8] }));
  const previous = { proposalKey: `old-${slot}`, invalidCauseSelection: { rejectedIndices: [0, 23], rejectedDomain } };
  return { profileId: "truth-deepseek", role: "truth-resolution", subjectId: `component-${slot}`,
    workloadId: "instance", batchId: "step", runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 },
    schemaName: "truth_resolution_continuation", schema: resolutionContinuationDirectiveSchema,
    system: prompt.system, userPrompt: prompt.userPrompt, promptVersion: prompt.version,
    context: { contractVersion: 16, roleContract: { role: "truth-resolution" },
      execution: { worldId: "world", instanceId: "instance", advanceId: "step", revision: 0, step: 0 },
      task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
      state: { completeAction: `Try action ${slot} only if all conditions hold; retain quantity, timing and recipient.`,
        currentFacts: { time: 0, permission: false }, currentRandom: [] },
      referenceCatalog: { version: 2, hash: "test", candidates: [
        { handle: "ref:fact:a", kind: "fact", allowedUses: ["assertion"], visibility: "role", label: "A" },
        { handle: "ref:fact:b", kind: "fact", allowedUses: ["assertion"], visibility: "role", label: "B", statePath: null },
        { handle: "ref:fact:scoped", allowedUses: slot === 0 ? ["assertion"] : ["cause"], value: slot },
        { handle: `ref:action:${slot}`, kind: "action", allowedUses: ["cause"] },
      ] }, repair: repair ? { previousOutput: { plans: [previous] }, issues: [{ code: "test.source", message: `Fix only source ${slot}.`, originalValue: previous }] } : null } };
}

it.each([false, true])("preserves real batched requests, slot permissions and HTTP output validation (repair=%s)", async repair => {
  const catalog = createTestModelCatalog(["truth-deepseek"]), bodies: Array<{ messages: Array<{ content: string }> }> = [];
  let physical: StructuredModelRequest<unknown> | undefined;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "planning-catalog-test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ slots: [0, 1].map(slot => ({ slot, result: { kind: "done" } })) }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    } });
  const encoded = planningCatalogEncodingProvider(gateway), send = encoded.generateStructured.bind(encoded);
  encoded.generateStructured = input => { physical = input; return send(input); };
  const baseline = new TruthBatchCoordinator(gateway, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const candidate = new TruthBatchCoordinator(encoded, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const inputs = [request(0, repair), request(1, repair)], hashes = inputs.map(r => contentHash(r.context));
  const before = await Promise.all(inputs.map(r => baseline.generateStructured(r)));
  const after = await Promise.all(inputs.map(r => candidate.generateStructured(r)));
  expect(bodies).toHaveLength(2);
  expect(after.map(r => r.value)).toEqual(before.map(r => r.value));
  expect(inputs.map(r => contentHash(r.context))).toEqual(hashes);
  const plain = recordedContext(bodies[0]!.messages[1]!.content).value;
  const compact = recordedContext(bodies[1]!.messages[1]!.content).value;
  if (repair) expect(compact.state).toHaveProperty("repairDiagnosticDomains");
  const restoredState = expandSharedCatalogPrefix(expandSharedCatalogRecords(expandRepairDiagnosticDomains(compact.state)));
  expect({ ...compact, state: restoredState }).toEqual(plain);
  expect(expandSharedBatchContexts(restoredState)).toEqual(inputs.map(r => r.context));
  expect(bodies[1]!.messages[0]).toEqual(bodies[0]!.messages[0]);
  const source = physical!, result = planningCatalogEncodingRequest(source);
  expect(result.schema).toBe(source.schema);
  expect(result.preprocessOutput).toBe(source.preprocessOutput);
  expect(result.jsonObjectPostlude).toBe(source.jsonObjectPostlude);
  expect(result.promptVersion).toContain(PLANNING_CATALOG_ENCODING);
  expect(() => planningCatalogEncodingRequest(result)).toThrow("already applied");
  expect(() => planningCatalogEncodingRequest({ ...source, context: { ...plain, state: {} } })).toThrow();
  for (const schemaName of ["truth_resolution_plan_commit_batch", "resolution_plan_verification_batch"]) {
    const r = planningCatalogEncodingRequest({ ...source, schemaName, role: schemaName.startsWith("resolution") ? "causal-verifier" : "truth-resolution" });
    expect(expandSharedCatalogPrefix(expandSharedCatalogRecords(expandRepairDiagnosticDomains((r.context as Record<string, unknown>).state)))).toEqual(plain.state);
  }
  expect(planningCatalogEncodingRequest(inputs[0]!)).toBe(inputs[0]);
  expect(planningCatalogEncodingRequest({ ...source, role: "observation-renderer" }).context).toBe(source.context);
  expect(() => result.schema.parse({ slots: [{ slot: 0, result: { kind: "invented" } }] })).toThrow();
});

it("sends physical structural recovery through catalog encoding without losing the original prefix", async () => {
  const catalog = createTestModelCatalog(["truth-deepseek"]), bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const rejected = { slots: "malformed physical envelope" };
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const value = bodies.length === 1 ? rejected : { slots: [0, 1].map(slot => ({ slot, result: { kind: "done" } })) };
      return new Response(JSON.stringify({ id: `catalog-physical-repair-${bodies.length}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    } });
  const coordinator = new TruthBatchCoordinator(planningCatalogEncodingProvider(gateway), 12, 1, "shared-json-v3",
    TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const inputs = [request(0, false), request(1, false)], hashes = inputs.map(input => contentHash(input.context));
  const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
  expect(results.map(result => result.value)).toEqual([{ kind: "done" }, { kind: "done" }]);
  expect(bodies).toHaveLength(2);
  const initial = bodies[0]!.messages[1]!.content, repaired = bodies[1]!.messages[1]!.content;
  expect(repaired.startsWith(initial)).toBe(true);
  expect(repaired.split(PHYSICAL_BATCH_REPAIR_NOTICE)).toHaveLength(2);
  const feedback = JSON.parse(repaired.slice(repaired.lastIndexOf("\n\n") + 2)).batchRepair;
  expect(feedback.expectedSlots).toEqual([0, 1]);
  expect(feedback.previousOutput).toEqual(rejected);
  expect(feedback.issues.length).toBeGreaterThan(0);
  expect(recordedContext(repaired).value).toEqual(recordedContext(initial).value);
  expect(inputs.map(input => contentHash(input.context))).toEqual(hashes);
});

it("pins the optional encoding in the real Composition and leaves defaults unselected", () => {
  const foundation = { sourceInventory: true, resolutionRepresentation: RESOLUTION_DEPENDENT_FIELDS_CODEC,
    truthTransport: "shared-state-first-v1", planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE } as const;
  const base = stepEfficiencyAlgorithmRef(foundation), encoded = stepEfficiencyAlgorithmRef({ ...foundation, planningCatalogEncoding: true });
  expect(registerBuiltinAlgorithms().has(encoded)).toBe(true);
  expect(encoded.children.truthResolution!.config.planningCatalogEncoding).toBe(PLANNING_CATALOG_ENCODING);
  expect(base.children.truthResolution!.config.planningCatalogEncoding).toBeUndefined();
  expect(encoded.manifestHash).not.toBe(base.manifestHash);
  expect(() => stepEfficiencyAlgorithmRef({ planningCatalogEncoding: true })).toThrow("requires the indexed reviewed pipeline");
});
