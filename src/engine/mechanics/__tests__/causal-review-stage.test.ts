import type { CausalReviewEvidence } from "../../algorithms/roles";
import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog, ScriptedModelProvider } from "../../testing/model-provider";
import { assertCausalReviewMatches, TruthEngine } from "../truth-engine";

const scope = { workloadId: "bound-review-world", batchId: "bound-review-step" };
const scopeFor = (evidence: CausalReviewEvidence) => ({ ...scope, runtimeIdentity: {
  worldHash: evidence.state.worldHash, revision: evidence.state.revision,
} });
const accept = { verdict: "accept", findings: [] };

function fixture(provider: ScriptedModelProvider): CausalReviewEvidence {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 47, modelCatalog: provider.catalog,
  });
  const state = structuredClone(definition.initialState);
  return {
    definition, state,
    workset: { state, mode: "full", initialActions: [], availableActions: [], assignedActions: [],
      availableDependencies: [], assignedDependencies: [] },
    checkRequests: [], checkResults: [], randomRequests: [], randomResults: [], commitmentRounds: [],
    resolutionPlans: [], resolutionReceipts: [], assertionResults: [], mechanicResults: [],
    previousReport: null, instanceId: scope.workloadId, advanceId: scope.batchId,
    proposal: { baseRevision: state.revision, outcomes: [], operations: [], events: [], mechanicInvocations: [],
      decisionRequests: [], observations: [{ id: "reviewed-observation", observerId: "player", step: 1,
        kind: "outcome", summary: "The courtyard remains quiet.", introductions: [], apparentClaims: [], sourceEventIds: [] }] },
  };
}

it("binds a single existing reviewer call to complete evidence, not just the observer identity", async () => {
  const provider = new ScriptedModelProvider(() => accept, createTestModelCatalog(), false);
  const evidence = fixture(provider);
  const result = await new TruthEngine(provider).reviewCandidate(evidence, scopeFor(evidence), "component", 3);
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests[0]).toMatchObject({ role: "causal-verifier", schemaName: "causal_verification" });
  expect(result.audit.invocations).toHaveLength(1);
  expect(() => assertCausalReviewMatches(evidence, result)).not.toThrow();
  const mutations: Array<(copy: CausalReviewEvidence) => void> = [
    copy => { copy.proposal.observations[0]!.summary = "Someone has answered."; },
    copy => { copy.state.truth.elapsedSeconds += 1; },
    copy => { copy.definition.laws = []; },
    copy => { copy.reactionDecisions = []; },
    copy => { copy.advanceId = "another-step"; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(evidence);
    mutate(copy);
    expect(() => assertCausalReviewMatches(copy, result)).toThrow("evidence binding mismatch");
  }
  expect(() => assertCausalReviewMatches(evidence, {
    ...result, binding: { ...result.binding, promptVersion: "other-prompt" },
  })).toThrow("evidence binding mismatch");
});

it("materializes rejected references without granting an accepted binding", async () => {
  const provider = new ScriptedModelProvider(() => ({ verdict: "reject", findings: [{
    target: { kind: "observation", targetHandle: "ref:observation:reviewed-observation" },
    evidenceHandles: ["ref:entity:player"], code: "observation-mismatch",
    message: "The observation asserts an unobserved answer.", repairHint: "Retain the unresolved question.",
  }] }), createTestModelCatalog(), false);
  const evidence = fixture(provider);
  const result = await new TruthEngine(provider).reviewCandidate(evidence, scopeFor(evidence), "component");
  expect(result.value).toMatchObject({ verdict: "reject", findings: [{
    target: { kind: "observation", id: "reviewed-observation" }, code: "observation-mismatch",
  }] });
  expect(provider.requests).toHaveLength(1);
  expect(() => assertCausalReviewMatches(evidence, result)).toThrow("did not accept");
});

it("keeps in-flight evidence immutable across a malformed response and its bounded repair", async () => {
  const seen: string[] = [];
  const provider = new ScriptedModelProvider(({ context }) => {
    const candidate = (context as { state: { candidate: { observations: Array<{ summary: string }> } } }).state.candidate;
    seen.push(candidate.observations[0]!.summary);
    if (seen.length === 1) {
      evidence.proposal.observations[0]!.summary = "The caller replaced the observation.";
      // A provider may also retain or mutate the object it received.
      candidate.observations[0]!.summary = "The provider changed its input.";
      return { verdict: "accept", findings: ["invalid"] };
    }
    return accept;
  }, createTestModelCatalog(), false);
  const evidence = fixture(provider);
  const original = structuredClone(evidence);
  const result = await new TruthEngine(provider, { repairAttempts: 1 }).reviewCandidate(evidence, scopeFor(evidence), "component");
  expect(seen).toEqual([original.proposal.observations[0]!.summary, original.proposal.observations[0]!.summary]);
  expect(result.audit.invocations).toHaveLength(2);
  expect(() => assertCausalReviewMatches(original, result)).not.toThrow();
  expect(() => assertCausalReviewMatches(evidence, result)).toThrow("evidence binding mismatch");
});

it("rejects a finding whose declared target kind disagrees with the evidence handle", async () => {
  const provider = new ScriptedModelProvider(() => ({ verdict: "reject", findings: [{
    target: { kind: "outcome", targetHandle: "ref:observation:reviewed-observation" },
    evidenceHandles: [], code: "effect-mismatch", message: "Mismatched identity", repairHint: "Fix the target kind",
  }] }), createTestModelCatalog(), false);
  const evidence = fixture(provider);
  await expect(new TruthEngine(provider, { repairAttempts: 0 }).reviewCandidate(evidence, scopeFor(evidence), "component"))
    .rejects.toThrow("target kind does not match");
  expect(provider.requests).toHaveLength(1);
});
