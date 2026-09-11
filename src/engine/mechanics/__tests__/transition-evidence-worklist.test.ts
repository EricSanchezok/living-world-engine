import { expect, it } from "vitest";
import { z } from "zod";
import { transitionProposalSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { promptBundle } from "../../prompts";
import { createTestModelCatalog, createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { TEST_WORLD_HASH } from "../../testing/world";
import { indexedReviewedPlanningProvider } from "../indexed-reviewed-planning-pipeline";
import { SourceIndexedTransitionCodec, indexedTransitionProvider } from "../source-indexed-transition";
import { expandSharedBatchContexts, factorSharedBatchContexts, type SharedBatchContext } from "../shared-batch-context";
import { OrderedRandomStream } from "../ordered-random-stream";
import type { StructuredModelRequest } from "../../models/model-provider";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { canonicalTransitionEvidenceRequest, restoreTransitionWorklistContext, transitionIntervalWorklistProvider, transitionWorklistContext } from "../transition-evidence-worklist";
import { expandTransitionAssertionReferences } from "../transition-schema-references";
import { logicalRepairContext } from "../../prompts/logical-repair-context";

function fixture() {
  const contexts = [0, 1].map(slot => {
    const actionRef = `ref:action:a${slot}`, factRef = `ref:fact:f${slot}`;
    const action = { actionRef, rawText: "先等待同伴，再把两袋粮食交给指定守卫；不得泄露路线。", goal: "Deliver after arrival with the original audience" };
    const plan = { actionRef, actorRef: `ref:entity:worker${slot}`, targetRefs: [`ref:entity:recipient${slot}`], goal: action.goal, mode: "automatic", causes: [{ kind: "fact", ref: factRef }] };
    const candidates = [actionRef, factRef].map(handle => ({ handle, allowedUses: ["cause", "assertion"] }));
    return { contractVersion: 2, roleContract: { stage: "transition" }, execution: { instanceId: "fixture", advanceId: "step-1", revision: 0, step: 0, worldId: "fixture" },
      task: { stage: "transition", assignment: { targetHandles: [actionRef], availableHandles: [actionRef], allowedProposalKinds: [] }, constraints: [] }, repair: null,
      referenceCatalog: { version: 2, hash: contentHash(candidates), candidates },
      state: { baseRevision: 0, actionSet: { assigned: [action] }, committedResolutionPlans: [plan], resolutionReceipts: [{ plan, outcome: "full", settled: true }],
        canonicalTruth: { facts: {
          [factRef]: { subjectRef: `ref:entity:worker${slot}`, value: { kind: "number", value: 2 }, statement: "Only two bags are available" },
          [`ref:fact:pending${slot}`]: { subjectRef: `ref:entity:recipient${slot}`, value: { kind: "text", value: "ceremony-in-progress" }, statement: "The recipient's ceremony has not finished" },
          "ref:fact:unrelated": { subjectRef: "ref:entity:unrelated", value: { kind: "text", value: "retained in full source" } },
        }, entities: {
          [`ref:entity:worker${slot}`]: { placementRef: "ref:placement:store", lifecycle: "active" },
          [`ref:entity:recipient${slot}`]: { placementRef: "ref:placement:hall", lifecycle: "active" },
        }, placements: { "ref:placement:store": "ref:placement:town", "ref:placement:hall": "ref:placement:town", "ref:placement:town": null } },
        temporalExecution: { boundary: { fromElapsedSeconds: 0, toElapsedSeconds: 10 },
          activities: { [`ref:activity:t${slot}`]: { sourceActionRef: actionRef, completionAtSeconds: null, plan: { mode: "goal" } } } } } };
  });
  const context = { task: { slots: [{ slot: 0 }, { slot: 1 }], assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] } },
    referenceCatalog: { version: 2, hash: "physical-metadata", candidates: [] }, state: factorSharedBatchContexts(contexts, "shared-json-v3") };
  return { contexts, context };
}

it("collects canonical transitions released through the real ordered commitment chain without losing contexts or outcomes", async () => {
  const contexts = fixture().contexts, prompt = promptBundle("truth-transition");
  const expected = (index: number) => ({ outcomes: [{ proposalKey: `waiting-${index}`, actionRef: `ref:action:a${index}`, status: "continuing",
    summary: "等待同伴到达；尚未交付。", causes: [{ kind: "action", ref: `ref:action:a${index}` }],
    assertions: [{ kind: "fact_matches", factRef: `ref:fact:f${index}`, expected: { kind: "number", value: 2 } }] }],
    operations: [], events: [], mechanicInvocations: [], decisionRequests: [] });
  const scripted = (index: number) => {
    const result = expected(index);
    return { ...result, outcomes: result.outcomes.map(outcome => ({ ...outcome,
      assertions: outcome.assertions.map(({ factRef, ...assertion }) => ({ ...assertion, factId: factRef })) })) };
  };
  const provider = new ScriptedModelProvider(input => {
    if (input.schemaName === "truth_transition") return scripted(Number(input.subjectId));
    const slots = expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state);
    return { slots: slots.map((context, slot) => ({ slot, result: scripted(contexts.findIndex(source => contentHash(source) === contentHash(context))) })) };
  }, createTestModelCatalog(["truth-deepseek"]), false);
  const physical: StructuredModelRequest<unknown>[] = [], generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => { physical.push(request); return generate(request); };
  const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1", "post-promise-v1");
  const rng = { seed: 47, state: 47, draws: 0 }, stream = new OrderedRandomStream(rng, contexts.length);
  const results = await Promise.all(contexts.map(async (context, index) => {
    // TruthEngine releases this exact asynchronous barrier after commitments
    // and before requesting the canonical transition.
    expect(await stream.finish(index, rng)).toEqual(rng);
    return coordinator.generateStructured({ ...prompt, role: "truth-transition", profileId: "truth-deepseek", workloadId: "fixture", batchId: "step-1",
      subjectId: String(index), promptVersion: prompt.version, context, schemaName: "truth_transition", schema: transitionProposalSchema,
      runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 } });
  }));
  expect(physical).toHaveLength(1);
  expect(physical[0]!.schemaName).toBe("truth_transition_batch");
  expect(expandSharedBatchContexts((physical[0]!.context as { state: SharedBatchContext }).state)).toEqual(contexts);
  expect(results.map(result => result.value)).toEqual(contexts.map((_, index) => expected(index)));
});

it("retains the same evidence and canonical output for a single component, including logical repair", async () => {
  const { contexts, context: physical } = fixture(), source = contexts[0]!;
  const bundle = promptBundle("truth-transition");
  const baseline = createTestModelCatalog(["truth-deepseek"]), profile = baseline.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: baseline.scheduler, registry: baseline.registry, accounts: baseline.accounts,
    model_overrides: {}, profiles: { "truth-deepseek": { ...profile, inference: { ...profile.inference, thinking: "disabled" } } } });
  const expected = { outcomes: [{ proposalKey: "waiting", actionRef: "ref:action:a0", status: "continuing", summary: "等待同伴到达；尚未交付。",
    causes: [{ kind: "action", ref: "ref:action:a0" }], assertions: [{ kind: "fact_matches", factRef: "ref:fact:f0", expected: { kind: "number", value: 2 } }] }],
  operations: [], events: [], mechanicInvocations: [], decisionRequests: [] };
  let calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.messages[1].content).toContain("participantEntities");
      expect(body.messages[1].content).not.toContain("Example JSON output shape");
      return new Response(JSON.stringify({ id: "singleton", model: "scripted:truth-deepseek", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(expected) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const coordinator = new TruthBatchCoordinator(indexedReviewedPlanningProvider(gateway), 12, 1, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const physicalRows = (transitionWorklistContext(new SourceIndexedTransitionCodec(physical).context(physical)).task as { transitionWorklist: { actions: Array<Record<string, unknown>> } }).transitionWorklist.actions;
  for (const context of [source, logicalRepairContext(source, { attempt: 1, scope: "step", targetIds: [], issues: [], previousOutput: expected }, contentHash(source), "truth_transition")]) {
    const request = { ...bundle, role: "truth-transition" as const, profileId: "truth-deepseek", workloadId: "singleton", batchId: "whole-component", subjectId: "source",
      promptVersion: bundle.version, runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 }, context, schemaName: "truth_transition", schema: transitionProposalSchema };
    const adapted = canonicalTransitionEvidenceRequest(request), restored = structuredClone(adapted.context) as Record<string, unknown>;
    const task = restored.task as { transitionWorklist?: { actions: unknown[] } };
    const physicalRow = { ...physicalRows[0]! }; delete physicalRow.slot; delete physicalRow.actionIndex;
    expect(task.transitionWorklist!.actions).toEqual([physicalRow]);
    delete task.transitionWorklist; expect(restored).toEqual(context);
    const schema = expandTransitionAssertionReferences(adapted.wireJsonSchema!);
    const expectedSchema = z.toJSONSchema(transitionProposalSchema, { target: "draft-07" });
    const outcomes = (expectedSchema.properties!.outcomes as Record<string, unknown>);
    outcomes.minItems = 1; outcomes.maxItems = 1;
    const fields = (outcomes.items as { properties: Record<string, Record<string, unknown>> }).properties;
    fields.actionRef = { ...fields.actionRef, enum: ["ref:action:a0"] };
    expect(schema).toEqual(expectedSchema);
    expect(adapted.schema).toBe(request.schema);
    expect(adapted.repairContextPlacement).toBeUndefined();
    expect((await coordinator.generateStructured(request)).value).toEqual(expected);
    expect(() => canonicalTransitionEvidenceRequest(adapted)).toThrow(/contract drift/u);
  }
  expect(calls).toBe(2);
});

it("joins exact original evidence and restores the entire physical source without broadening slots", () => {
  const { context } = fixture(), codec = new SourceIndexedTransitionCodec(context), indexed = codec.context(context), before = contentHash(indexed);
  const framed = transitionWorklistContext(indexed), task = framed.task as { transitionWorklist: { actions: Array<Record<string, unknown>> } };
  expect(framed).not.toHaveProperty("referenceCatalog");
  expect(framed.task).not.toHaveProperty("assignment");
  expect(framed.physicalEnvelopeAudit).toHaveProperty("referenceCatalog.candidates", []);
  expect(task.transitionWorklist.actions).toHaveLength(2);
  expect(Object.keys(task.transitionWorklist.actions[0]!.inputFacts as object)).toEqual(["ref:fact:f0", "ref:fact:pending0"]);
  expect(task.transitionWorklist.actions[0]!.participantEntities).toEqual(fixture().contexts[0]!.state.canonicalTruth.entities);
  expect(task.transitionWorklist.actions[0]!.placementAncestors).toEqual(fixture().contexts[0]!.state.canonicalTruth.placements);
  expect(task.transitionWorklist.actions[0]!.inputFacts).not.toHaveProperty("ref:fact:unrelated");
  expect(task.transitionWorklist.actions[0]!.receipts).toMatchObject([{ outcome: "full", settled: true }]);
  expect(restoreTransitionWorklistContext(framed)).toEqual(indexed);
  expect(contentHash(indexed)).toBe(before);
  const changed = structuredClone(framed);
  ((changed.task as typeof task).transitionWorklist.actions[0]!.receipts as Array<{ settled: boolean }>)[0]!.settled = false;
  expect(() => restoreTransitionWorklistContext(changed)).toThrow("source evidence or layout changed");
  expect(() => transitionWorklistContext(framed)).toThrow();
  const missing = fixture(); delete missing.contexts[0]!.state.canonicalTruth.facts["ref:fact:f0"];
  missing.context.state = factorSharedBatchContexts(missing.contexts, "shared-json-v3");
  expect(() => transitionWorklistContext(new SourceIndexedTransitionCodec(missing.context).context(missing.context))).toThrow("cited fact missing");
  const missingEntity = fixture(); delete missingEntity.contexts[0]!.state.canonicalTruth.entities["ref:entity:worker0"];
  missingEntity.context.state = factorSharedBatchContexts(missingEntity.contexts, "shared-json-v3");
  expect(() => transitionWorklistContext(new SourceIndexedTransitionCodec(missingEntity.context).context(missingEntity.context))).toThrow("participant entity missing");
  const cyclic = fixture(); cyclic.contexts[0]!.state.canonicalTruth.placements["ref:placement:store"] = "ref:placement:store";
  cyclic.context.state = factorSharedBatchContexts(cyclic.contexts, "shared-json-v3");
  expect(() => transitionWorklistContext(new SourceIndexedTransitionCodec(cyclic.context).context(cyclic.context))).toThrow("cyclic participant placement");
});

it.each(["mechanical", "empty-root", "invalid-slot", "invalid-first-assertion", "invalid-interval-evidence", "missing-interval-legacy-summary"] as const)("preserves batch recovery and valid neighbors for %s through the actual gateway", async failure => {
  const { contexts } = fixture(), bundle = promptBundle("truth-transition"), base = createTestModelCatalog(["truth-deepseek"]), profile = base.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: base.scheduler, registry: base.registry, accounts: base.accounts,
    model_overrides: {}, profiles: { "truth-deepseek": { ...profile, inference: { ...profile.inference, thinking: "disabled" } } } });
  let calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++; const body = JSON.parse(String(init?.body)), text = body.messages[1].content;
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(text).toContain("task.transitionWorklist.actions");
      expect(text).toContain("Only two bags are available");
      expect(text).toContain("The recipient's ceremony has not finished");
      expect(text).toContain("participantEntities");
      if (failure === "mechanical") expect(text).not.toContain("synthetic demonstrations");
      if (calls === 2) expect(text).toContain("missing action indices: 0, 1");
      const outcomes = calls === 1 && failure === "empty-root" ? [] : [0, 1].map(actionIndex => ({ actionIndex, proposalKey: `o${actionIndex}`, status: failure === "invalid-slot" && actionIndex === 0 ? "invalid-status" : "continuing",
        ...((failure === "missing-interval-legacy-summary" && actionIndex === 0) || failure === "mechanical" ? { summary: "Legacy summary must not bypass interval checks" } : {
          intervalAssessment: { currentWork: "等待同伴，尚未交付；两袋粮食仍在保管中。", pendingSourceRanges: [{ first: 0, last: 1 }],
            gates: [{ sourceSegmentIndices: [0], requirement: "The recipient must be available", state: "pending", evidencePointers: [
              failure === "invalid-interval-evidence" && actionIndex === 0 ? "/inputFacts/missing" : `/inputFacts/ref:fact:pending${actionIndex}/value`,
            ] }] } }),
        causes: [{ kind: "action", ref: `ref:action:a${actionIndex}` }],
        firstAssertion: failure === "invalid-first-assertion" && actionIndex === 0 ? null : { kind: "elapsed_seconds_compare", operator: "eq", value: 10 }, additionalAssertions: [] }));
      return new Response(JSON.stringify({ id: `response-${calls}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ slots: [0, 1], outcomes, mechanicInvocations: [], operations: [], events: [], decisionRequests: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const coordinator = new TruthBatchCoordinator(failure === "mechanical" ? indexedReviewedPlanningProvider(gateway) : indexedTransitionProvider(transitionIntervalWorklistProvider(gateway)), 12, 1,
    "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const results = await Promise.allSettled(contexts.map((context, slot) => coordinator.generateStructured({ ...bundle, role: "truth-transition", profileId: "truth-deepseek",
    workloadId: "qualified", batchId: "root", subjectId: `slot-${slot}`, promptVersion: bundle.version,
    runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: 0 }, context, schemaName: "truth_transition", schema: transitionProposalSchema,
    jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1" })));
  expect(calls, JSON.stringify(results.map(result => result.status === "rejected" ? String(result.reason) : "fulfilled"))).toBe(failure === "empty-root" ? 2 : 1);
  expect(results.map(result => result.status)).toEqual(["empty-root", "mechanical"].includes(failure) ? ["fulfilled", "fulfilled"] : ["rejected", "fulfilled"]);
  const retained = results.flatMap(result => result.status === "fulfilled" ? result.value.value.outcomes.map(outcome => outcome.actionRef) : []);
  expect(retained).toEqual(["empty-root", "mechanical"].includes(failure) ? ["ref:action:a0", "ref:action:a1"] : ["ref:action:a1"]);
});
