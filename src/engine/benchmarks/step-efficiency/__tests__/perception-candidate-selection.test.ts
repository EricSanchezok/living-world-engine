import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionDirectiveSchema } from "../../../contracts/llm-schemas";
import { existingReferenceHandleSchemaFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { combineModelExecutionAudits, modelInvocationIdentity, ModelOutputError, type StructuredModelProvider } from "../../../models/model-provider";
import { TruthEngine, materializeOnsetPerceptionChecks } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { createTestModelCatalog, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { PerceptionCandidateSelection, PERCEPTION_CANDIDATE_SELECTION } from "../perception-candidate-selection";

it.each(["reports", "checks", "abstain", "ineligible"])("selects an unchanged whole candidate through real gateway and TruthEngine (%s)", async mode => {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  const state = definition.initialState;
  const input = { definition, state, identityOwner: "candidate-selection", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Hide the key", goal: "Keep it hidden", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const done = { kind: "done", reports: noStimulusReportsForTargets(input) };
  const checked = perceptionDirectiveSchema.parse({ kind: "request_checks", requests: [{ proposalKey: "notice", actorRef: "ref:entity:keeper",
    targetRef: "ref:entity:key", ratingRef: "ref:rating:resolve:keeper", difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } },
    mode: "normal", stakes: "Notice concealment", visibility: "full", causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }] }] });
  if (checked.kind !== "request_checks") throw new Error("fixture check kind");
  const bad = { kind: "done", reports: [{ ...done.reports[0], evidence: [{ kind: "action", ref: "ref:action:conceal" }] }] };
  const before = contentHash(input);
  const expectedChecks = materializeOnsetPerceptionChecks({ ...input, requests: [], commitmentRound: 0 }, checked.requests);
  expect(contentHash(input)).toBe(before);
  expect(() => materializeOnsetPerceptionChecks({ ...input, requests: expectedChecks, commitmentRound: 1 }, checked.requests)).toThrow();
  expect(() => materializeOnsetPerceptionChecks({ ...input, requests: [], commitmentRound: 0 }, [{ ...checked.requests[0]!, ratingRef: existingReferenceHandleSchemaFor("rating").parse("ref:rating:resolve:player") }])).toThrow();
  let calls = 0, pooled = false;
  const bodies: unknown[] = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (url, init) => {
      const body = await new Request(url, init).json(); bodies.push(body); const ordinal = calls++;
      const output = ordinal < 3 ? [bad, done, checked][ordinal] : ordinal === 3
        ? { candidateIndex: mode === "abstain" ? null : mode === "ineligible" ? 0 : mode === "checks" ? 2 : 1, reason: "fixture selection" } : done;
      return new Response(JSON.stringify({ id: `candidate-${ordinal}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
      const version = `${request.promptVersion}/${PERCEPTION_CANDIDATE_SELECTION}`;
      const identity = (ordinal: number) => modelInvocationIdentity({ ...request, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, request.role, request.subjectId, ordinal);
      if (pooled) return gateway.generateStructured({ ...request, promptVersion: version, ...identity(5) });
      pooled = true;
      const audits = [];
      const samples = [];
      for (let index = 0; index < 3; index++) {
        try {
          const result = await gateway.generateStructured({ ...request, promptVersion: version, ...identity(index + 1) });
          audits.push(result.audit); samples.push({ value: result.value, providerAccepted: true });
        } catch (error) {
          if (!(error instanceof ModelOutputError) || !error.audit || error.rawValue === undefined) throw error;
          audits.push(error.audit); samples.push({ value: error.rawValue, providerAccepted: false, failure: error.message });
        }
      }
      const source = { ...input, targets: input.perceptionTargets, requests: [], checks: [] };
      const chooser = new PerceptionCandidateSelection(request, source, samples);
      expect(chooser.view().eligibleIndices).toEqual([1, 2]);
      const copy = chooser.view(); copy.candidates[1]!.value = {};
      expect(chooser.decode({ candidateIndex: 1, reason: "exact" })).toEqual(done);
      expect(() => chooser.decode({ candidateIndex: 0, reason: "invalid" })).toThrow("rejected");
      expect(() => chooser.decode({ candidateIndex: 3, reason: "invented" })).toThrow();
      const rejected = new PerceptionCandidateSelection(request, source, samples.map(sample => ({ ...sample, providerAccepted: false })));
      expect(() => rejected.request()).toThrow("no mechanically eligible");
      const candidateRequest = chooser.request();
      const context = structuredClone(candidateRequest.context) as Record<string, unknown>;
      context.roleContract = (context.candidateSelection as Record<string, unknown>).originalRoleContract; delete context.candidateSelection;
      expect(context).toEqual(request.context);
      const result = await gateway.generateStructured({ ...candidateRequest, ...identity(4) }); audits.push(result.audit);
      const selected = chooser.decode(result.value);
      const sourceCopy = structuredClone(source), bound = new PerceptionCandidateSelection(request, sourceCopy, samples);
      sourceCopy.state.step++;
      expect(() => bound.decode({ candidateIndex: 1, reason: "stale" })).toThrow("source changed");
      expect(bodies[0]).toEqual(bodies[1]); expect(bodies[1]).toEqual(bodies[2]);
      return { value: request.schema.parse(selected), audit: combineModelExecutionAudits(audits) };
    } };
  const run = new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "sample-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  if (mode === "abstain" || mode === "ineligible") await expect(run).rejects.toThrow();
  else {
    const result = await run;
    expect(result.receipts).toHaveLength(1); expect(result.requests).toEqual(mode === "checks" ? expectedChecks : []);
    expect(result.modelAudit.invocations).toHaveLength(mode === "checks" ? 5 : 4);
  }
  expect(calls).toBe(mode === "checks" ? 5 : 4); expect(contentHash(input)).toBe(before);
});
