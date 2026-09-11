import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTruthReferenceResolver, projectCanonicalTruthForModel } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { createTestModelCatalog, createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { encodeResolutionDependentFields } from "../../mechanics/resolution-dependent-fields-codec";
import { expandSharedBatchContexts, SHARED_BATCH_ORDER_CODEC, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "./resolution-admission";
import { ModelGateway } from "../../models/model-gateway";
import { UNMATCHED_CLOSER_RECOVERY } from "../../models/unmatched-closer-recovery";
import { parseLastJsonValueWithRecovery } from "../../models/model-adapter";
import { assertPhysicalPlanningWorklist, physicalPlanningWorklistProvider } from "../../mechanics/physical-planning-worklist";
import { sourceBoundPlanChoicesProvider } from "../../mechanics/source-bound-plan-choices";
import { flatPlanBatchProvider } from "../../mechanics/flat-resolution-plan-batch";
import { planSelectorProvider } from "../../mechanics/plan-source-selectors";
import { factorTypesProvider } from "../../mechanics/resolution-factor-types";

function sourceFixture(): ResolutionAdmissionSource {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 19, modelCatalog: createTestModelCatalog() });
  const state = structuredClone(definition.initialState);
  const actions = ["player", "keeper"].map(actorId => ({ id: `watch-${actorId}`, actorId, rawText: "Watch the courtyard.",
    goal: "Observe the courtyard", means: null, targetIds: [], baseRevision: state.revision }));
  const resolver = createTruthReferenceResolver({ state, definition, actions });
  const contexts = actions.map(action => ({ execution: { instanceId: "admission-test", advanceId: "prepare:1" }, state: {
    canonicalTruth: projectCanonicalTruthForModel(state.truth, resolver),
    actionSet: { assigned: [{ actionRef: resolver.handleFor("action", action.id), rawText: action.rawText, goal: action.goal, means: action.means }] },
    temporalBoundary: { fromElapsedSeconds: state.truth.elapsedSeconds, toElapsedSeconds: state.truth.elapsedSeconds + 1,
      deltaSeconds: 1, reasons: [], dueActivityIds: [], dueTimerIds: [], dueConditionIds: [] },
  } }));
  return { definition, state, actions, contexts, groundings: actions.map(action => ({ kind: "action", id: action.id, actorId: action.actorId,
    reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false })) };
}

it.each([{ flat: false, bound: false, worklist: false }, { flat: true, bound: false, worklist: false }, { flat: true, bound: true, worklist: false }, { flat: true, bound: true, worklist: true }])("retains valid slots and repairs only the rejected action through real admission (%j)", async ({ flat, bound, worklist }) => {
  const source = sourceFixture();
  for (const entry of source.contexts) {
    const assigned = (entry as { state: { actionSet: { assigned: Array<{ actionRef: string; allowedMeansSources?: unknown[] }> } } }).state.actionSet.assigned;
    for (const action of assigned) action.allowedMeansSources = [{ kind: "action", ref: action.actionRef }];
  }
  const before = contentHash(source);
  let calls = 0;
  const provider = new ScriptedModelProvider(({ schemaName, context }) => {
    calls++;
    if (worklist) {
      const projected = (context as { task: { planningWorklist: { actionCount: number; actions: Array<{ action: { actionRef: string } }> } } }).task.planningWorklist;
      expect(projected.actionCount).toBe(calls === 1 ? 2 : 1);
      if (calls > 1) expect(projected.actions[0]!.action.actionRef).toBe("ref:action:watch-player");
    }
    const contexts = schemaName.endsWith("_batch") ? expandSharedBatchContexts((context as { state: SharedBatchContext }).state) : [context];
    const results = contexts.map(entry => {
      const input = entry as { state: { actionSet: { assigned: Array<{ actionRef: string; allowedMeansSources: Array<{ sourceSelector: string }> }> } }; repair: { previousOutput: unknown; issues: unknown[] } | null };
      const actionRef = input.state.actionSet.assigned[0]!.actionRef;
      if (calls > 1) {
        expect(contexts).toHaveLength(1); expect(actionRef).toBe("ref:action:watch-player");
        expect(JSON.stringify(input.repair?.previousOutput)).toContain(bound ? "0123456789ab" : "语义:risk");
        expect(JSON.stringify(input.repair?.issues)).toContain(bound ? "targetRefs" : "factors");
      }
      return { kind: "commit_plans", plans: [{ proposalKey: "watch", actionRef, targetRefs: bound && calls === 1 && actionRef === "ref:action:watch-player" ? ["e:0123456789ab"] : [],
        means: [{ description: "Observe", source: input.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector }], mode: "automatic", difficulty: null,
        actorRatingRef: null, factors: [{ factorType: !bound && calls === 1 && actionRef === "ref:action:watch-player" ? "语义:risk" : "semantic:risk",
          source: { kind: "action", ref: actionRef }, channel: null, explanation: "Observation may not reveal everything; no numeric penalty." }],
        risk: "safe", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] }] };
    });
    return schemaName.endsWith("_batch") ? flat ? { kind: "commit_plans", plans: results.flatMap(result => result.plans) } : { slots: results.map((result, slot) => ({ slot, result })) } : results[0];
  }, createTestModelCatalog(), false);
  // Inspect the actual physical request before the scripted fixture handler's
  // legacy section projection adds convenience members to its local context.
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => {
    if (worklist) assertPhysicalPlanningWorklist(request.context);
    return generate(request);
  };
  const result = await runResolutionAdmission(source, factorTypesProvider(planSelectorProvider(flat ? flatPlanBatchProvider(bound ? sourceBoundPlanChoicesProvider(worklist ? physicalPlanningWorklistProvider(provider) : provider) : provider) : provider)), { candidate: true, maxPhysicalRequests: 2, contextCodec: SHARED_BATCH_ORDER_CODEC });
  expect(calls, JSON.stringify(result.physicalFailures)).toBe(2);
  expect(result).toMatchObject({ complete: true, firstHttpComplete: false, stepCommitted: false, semanticVerdict: "unassessed" });
  expect(result.rows.map(row => row.admittedFromPhysicalRequest)).toEqual([2, 1]);
  expect(result.rows[1]!.repairEvidence).toEqual([]);
  expect(contentHash(source)).toBe(before);
});

it.each([
  { candidate: false, rejectRepair: false, ceiling: 3 },
  { candidate: true, rejectRepair: false, ceiling: 3 },
  { candidate: true, rejectRepair: true, ceiling: 3 },
  { candidate: true, rejectRepair: false, ceiling: 1 },
  { candidate: true, rejectRepair: false, ceiling: 3, contextCodec: SHARED_BATCH_ORDER_CODEC },
  { candidate: true, rejectRepair: true, ceiling: 3, contextCodec: SHARED_BATCH_ORDER_CODEC },
  { candidate: true, rejectRepair: false, ceiling: 3, contextCodec: SHARED_BATCH_ORDER_CODEC, includeActivityTemporalEvidence: true },
])("uses real slot retention and bounded repair before verifier or RNG: %j", async ({ candidate, rejectRepair, ceiling, contextCodec, includeActivityTemporalEvidence }) => {
  const source = sourceFixture(), before = contentHash(source);
  const temporalEvidence: unknown[] = [], reviewEvidence: unknown[] = [];
  let calls = 0;
  const provider = new ScriptedModelProvider(({ role, schemaName, context }) => {
    expect(role).toBe("truth-resolution");
    calls++;
    if (contextCodec && schemaName.endsWith("_batch")) {
      expect((context as { state: SharedBatchContext }).state.codec).toBe(contextCodec);
      expect((context as { state: SharedBatchContext }).state.catalogOrders).toBeDefined();
    }
    const contexts = schemaName.endsWith("_batch")
      ? expandSharedBatchContexts((context as { state: SharedBatchContext }).state) : [context];
    const results = contexts.map(entry => {
      const input = entry as { state: { actionSet: { assigned: Array<{ actionRef: string }>; available: unknown[] } }; repair: { issues: unknown[] } | null };
      if (includeActivityTemporalEvidence) temporalEvidence.push((entry as { state: { temporalExecution: unknown } }).state.temporalExecution);
      expect(input.state.actionSet.available).toHaveLength(2);
      if (calls > 1) {
        expect(contexts).toHaveLength(1);
        expect(input.state.actionSet.assigned[0]!.actionRef).toBe("ref:action:watch-player");
        if (calls === 2) expect(input.repair?.issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: ["plans", 0, "primaryEffect"] }),
          expect.objectContaining({ path: ["plans", 0, "threatenedEffect"] }),
        ]));
        else expect(JSON.stringify(input.repair?.issues).includes("baseEffect")).toBe(true);
      }
      const plans = input.state.actionSet.assigned.map(action => {
        const invalid = calls === 1 && action.actionRef === "ref:action:watch-player";
        return { proposalKey: "watch", actionRef: action.actionRef, targetRefs: [],
          means: [{ description: "Observe", source: { kind: "action", ref: action.actionRef } }],
          mode: invalid ? "check" : "automatic", difficulty: invalid ? { kind: "environment", band: "easy", source: { kind: "action", ref: action.actionRef } } : null,
          actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null,
          threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: action.actionRef }] };
      });
      const result = { kind: "commit_plans", plans };
      const wire = candidate ? encodeResolutionDependentFields(result) : result;
      if (candidate && rejectRepair && calls === 2) (wire as { plans: Array<Record<string, unknown>> }).plans[0]!.baseEffect = "major";
      return wire;
    });
    return schemaName.endsWith("_batch") ? { slots: results.map((result, slot) => ({ slot, result })) } : results[0];
  }, createTestModelCatalog(), false);
  const result = await runResolutionAdmission(source, provider, { candidate, maxPhysicalRequests: ceiling, contextCodec, includeActivityTemporalEvidence,
    onVerifierRequest: request => reviewEvidence.push((request.context as { state: { temporalExecution?: unknown } }).state.temporalExecution) });
  if (includeActivityTemporalEvidence) {
    expect(temporalEvidence).toHaveLength(3);
    expect(reviewEvidence).toHaveLength(2);
    expect(temporalEvidence[0]).toMatchObject({ boundary: { fromElapsedSeconds: 0, toElapsedSeconds: 1, deltaSeconds: 1 } });
    for (const evidence of [...temporalEvidence, ...reviewEvidence]) expect(evidence).toEqual(temporalEvidence[0]);
  } else expect(reviewEvidence.every(evidence => evidence === undefined)).toBe(true);
  const complete = ceiling > 1, expectedCalls = complete ? rejectRepair ? 3 : 2 : 1;
  if (complete) expect(result.rows.filter(row => !row.admitted).map(row => row.error)).toEqual([]);
  expect(result.rows.map(row => row.admitted)).toEqual([complete, true]);
  if (!complete) expect(result.rows[0]!.error).toContain("physical request ceiling reached");
  expect(result.rows[0]!.repairEvidence[0]).toMatchObject({ logicalAttempt: 2,
    issues: expect.arrayContaining([
      expect.objectContaining({ path: ["plans", 0, "primaryEffect"] }),
      expect.objectContaining({ path: ["plans", 0, "threatenedEffect"] }),
    ]) });
  expect(result.rows[1]!.repairEvidence).toEqual([]);
  if (rejectRepair) {
    expect(result.physicalFailures).toHaveLength(1);
    expect(result.physicalFailures[0]).toMatchObject({ physicalRequest: 2,
      cause: expect.stringContaining("baseEffect conflicts"), issues: expect.any(Array) });
  }
  expect(calls).toBe(expectedCalls);
  expect(result).toMatchObject({ physicalRequests: expectedCalls, complete, stepCommitted: false, semanticVerdict: "unassessed" });
  expect(result.firstHttpComplete).toBe(false);
  expect(result.rows.map(row => row.admittedFromPhysicalRequest)).toEqual([complete ? expectedCalls : null, 1]);
  expect(contentHash(source)).toBe(before);
});

it("rejects mismatched state and action evidence before requesting a model", () => {
  const source = sourceFixture();
  source.actions[0]!.rawText = "An altered action";
  expect(() => bindResolutionAdmission(source)).toThrow("meaning mismatch");
  const changed = sourceFixture();
  changed.state.truth.elapsedSeconds += 1;
  expect(() => bindResolutionAdmission(changed)).toThrow("snapshot mismatch");
});

it("retains expanded valid wire slots when another slot fails canonical schema validation", async () => {
  const source = sourceFixture();
  const provider = new ScriptedModelProvider(({ context }) => {
    const contexts = expandSharedBatchContexts((context as { state: SharedBatchContext }).state);
    return { slots: contexts.map((entry, slot) => {
      const actionRef = (entry as { state: { actionSet: { assigned: Array<{ actionRef: string }> } } }).state.actionSet.assigned[0]!.actionRef;
      return { slot, result: { kind: "commit_plans", plans: [{ proposalKey: "watch", actionRef, targetRefs: [],
        means: [{ description: "Observe", source: { kind: actionRef === "ref:action:watch-player" ? "invented-source-kind" : "action", ref: actionRef } }],
        mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", primaryEffect: null,
        secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] }] } };
    }) };
  }, createTestModelCatalog(), false);
  const result = await runResolutionAdmission(source, provider, { candidate: true, maxPhysicalRequests: 1 });
  expect(result.rows.map(row => row.admitted)).toEqual([false, true]);
  expect(result.physicalFailures).toHaveLength(1);
  expect(result.physicalFailures[0]!.cause).toContain("Invalid discriminator value");
  expect(JSON.stringify(result.rows[0]!.repairEvidence)).not.toContain("baseEffect");
  expect(result.rows[1]!.admittedFromPhysicalRequest).toBe(1);
});

it("uses the real gateway parser and retains valid slots without weakening a recovered invalid source", async () => {
  const source = sourceFixture(), catalog = createTestModelCatalog(undefined, { maxInputBytes: 2_000_000 });
  let text = "", calls = 0;
  const gateway = new ModelGateway(catalog, { TEST_MODEL_API_KEY: "local-fixture" }, {
    registry: createTestModelRegistry(catalog), fetch: async () => {
      calls++;
      return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "scripted:truth-engine",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    },
  });
  const result = await runResolutionAdmission(source, gateway, { candidate: true, maxPhysicalRequests: 1,
    jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY, onPhysicalRequest: request => {
      expect(request.jsonSyntaxRecovery).toBe(UNMATCHED_CLOSER_RECOVERY);
      const contexts = expandSharedBatchContexts((request.context as { state: SharedBatchContext }).state);
      const slots = contexts.map((entry, slot) => {
        const actionRef = (entry as { state: { actionSet: { assigned: Array<{ actionRef: string }> } } }).state.actionSet.assigned[0]!.actionRef;
        return { slot, result: { kind: "commit_plans", plans: [{ proposalKey: "watch", actionRef, targetRefs: [],
          means: [{ description: "Observe", source: { kind: actionRef === "ref:action:watch-player" ? "invented-source-kind" : "action", ref: actionRef } }],
          factors: [], risk: "safe", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
          visibility: "full", causes: [{ kind: "action", ref: actionRef }], mode: "automatic", difficulty: null, actorRatingRef: null }] } };
      });
      text = JSON.stringify({ slots }).replace('"actorRatingRef":null}', '"actorRatingRef":null}}');
      expect(() => parseLastJsonValueWithRecovery(text)).toThrow();
    } });
  expect(calls).toBe(1);
  expect(result.rows.map(row => row.admitted)).toEqual([false, true]);
  expect(result.rows[1]!.admittedFromPhysicalRequest).toBe(1);
  expect(JSON.stringify(result.rows[0]!.repairEvidence)).toContain("source");
  expect(JSON.stringify(result.rows[0]!.repairEvidence)).not.toContain("baseEffect");
  expect(result).toMatchObject({ stepCommitted: false, semanticVerdict: "unassessed" });
});
