import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { resolutionPlanCommitDirectiveSchema } from "../../../contracts/llm-schemas";
import { modelReferenceSchema } from "../../../contracts/model-context";
import { dependentFieldsRequest, encodeResolutionDependentFields } from "../../../mechanics/resolution-dependent-fields-codec";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { ModelConfigurationError, type StructuredModelProvider } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../../testing/model-provider";
import { PlanningCandidateSelection } from "../planning-candidate-selection";
import type { ResolutionAdmissionSource } from "../resolution-admission";

it.each(["selected", "rejected", "abstain", "edited"])("selects frozen plans through the real gateway and TruthEngine (%s)", async mode => {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  const state = definition.initialState;
  const actions = ["player", "keeper"].map(actorId => ({ id: `wait-${actorId}`, actorId, baseRevision: state.revision,
    rawText: "Wait and watch", goal: "See what happens", means: null, targetIds: [] }));
  const groundings: ResolutionAdmissionSource["groundings"] = actions.map(action => ({ kind: "action", id: action.id, actorId: action.actorId,
    reads: [{ kind: "entity", id: action.actorId }], writes: [{ kind: "entity", id: action.actorId }], audienceAgentIds: [action.actorId],
    sharedResourceClaims: [], globalFallback: false }));
  const input = { definition, state, initialActions: [actions[0]!], groundings: [groundings[0]!], identityOwner: "component-player",
    modelWorkset: { state, initialActions: actions, availableActions: actions, availableDependencies: groundings },
    resolutionScope: { mode: "component" as const, selectedActionIds: [actions[0]!.id], totalActionCount: actions.length },
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }),
    renderObservations: async () => { throw new Error("unexpected observation"); }, validateProposal: () => { throw new Error("unexpected commit"); } };
  const valid = resolutionPlanCommitDirectiveSchema.parse({ kind: "commit_plans", plans: [{ proposalKey: "watch", actionRef: "ref:action:wait-player",
    targetRefs: ["ref:entity:player"], means: [{ description: "Wait and watch", source: { kind: "action", ref: "ref:action:wait-player" } }],
    factors: [], risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
    visibility: "result_only", causes: [{ kind: "action", ref: "ref:action:wait-player" }], mode: "automatic", difficulty: null, actorRatingRef: null }] });
  const noOwnCause = structuredClone(valid); noOwnCause.plans[0]!.causes = [{ kind: "law", ref: modelReferenceSchema.parse("ref:law:time-passes") }];
  const wrongMeans = structuredClone(valid); wrongMeans.plans[0]!.means[0]!.source = { kind: "entity", ref: modelReferenceSchema.parse("ref:entity:keeper") };
  const candidates = [valid, noOwnCause, wrongMeans].map(encodeResolutionDependentFields);
  const before = contentHash({ state, actions, groundings });
  let http = 0, admitted = false;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (url, init) => {
      const body = await new Request(url, init).json();
      expect(JSON.stringify(body)).toContain("candidateSelection"); http++;
      const choice = { candidateIndex: mode === "abstain" ? null : mode === "rejected" ? 1 : 0, reason: "fixture source review",
        ...(mode === "edited" ? { plans: valid.plans } : {}) };
      return Response.json({ id: "selection", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(choice) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
      if (request.role === "causal-verifier") { admitted = true; throw new ModelConfigurationError("admission observed; stop before verifier and RNG"); }
      expect(request.schemaName).toBe("truth_resolution_plan_commit");
      const represented = dependentFieldsRequest(request);
      const source: ResolutionAdmissionSource = { definition, state, actions, groundings, contexts: [request.context] };
      const selector = new PlanningCandidateSelection(represented, source, candidates);
      const view = selector.view();
      expect(view.eligibleIndices).toEqual([0]);
      expect(view.candidates[1]!.screeningFailure).toContain("does not cite its action");
      expect(view.candidates[2]!.screeningFailure).toContain("means");
      view.candidates[0]!.raw = {};
      expect(selector.decode({ candidateIndex: 0, reason: "unchanged" })).toEqual(candidates[0]);
      expect(() => selector.decode({ candidateIndex: 3, reason: "unknown" })).toThrow();
      expect(() => new PlanningCandidateSelection(represented, source, [candidates[1], candidates[1], candidates[2]]).request()).toThrow("no eligible");
      const blocked = structuredClone(valid); blocked.plans[0]!.mode = "blocked";
      expect(new PlanningCandidateSelection(represented, source, [encodeResolutionDependentFields(blocked), candidates[0], candidates[0]])
        .view().candidates[0]!.screeningFailure).toContain("outside");
      const selectionRequest = selector.request();
      expect(selectionRequest.preprocessOutput).toBeUndefined(); expect(selectionRequest.jsonObjectPostlude).toBeUndefined();
      const restored = structuredClone(selectionRequest.context) as Record<string, unknown>;
      restored.roleContract = view.originalRoleContract; delete restored.candidateSelection;
      expect(restored).toEqual(request.context);
      const copiedSource = structuredClone(source), boundSource = new PlanningCandidateSelection(represented, copiedSource, candidates);
      copiedSource.state.step++;
      expect(() => boundSource.request()).toThrow("changed after binding");
      const copiedRequest = { ...represented }, boundRequest = new PlanningCandidateSelection(copiedRequest, source, candidates);
      copiedRequest.userPrompt += " drift";
      expect(() => boundRequest.decode({ candidateIndex: 0, reason: "stale" })).toThrow("changed after binding");
      const incomplete = { ...represented, context: structuredClone(represented.context) };
      (incomplete.context as { state: { actionSet: { available: unknown[] } } }).state.actionSet.available.pop();
      expect(() => new PlanningCandidateSelection(incomplete, source, candidates)).toThrow("complete original action set");
      const result = await gateway.generateStructured(selectionRequest);
      const raw = selector.decode(result.value);
      const decoded = represented.preprocessOutput!(raw);
      expect(decoded.symbolRepairs).toEqual([]); expect(decoded.value).toEqual(valid);
      return { value: request.schema.parse(decoded.value), audit: { ...result.audit, promptVersion: request.promptVersion } };
    } };
  const terminal = await new TruthEngine(provider, { repairAttempts: 0, includeResolutionMeansSources: true }).resolve(input,
    { workloadId: "planning-selection", batchId: "planning-selection", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }).catch(error => error);
  if (!http) throw terminal;
  expect(terminal).toBeInstanceOf(Error);
  expect(http).toBe(1); expect(admitted).toBe(mode === "selected");
  expect(contentHash({ state, actions, groundings })).toBe(before);
});
