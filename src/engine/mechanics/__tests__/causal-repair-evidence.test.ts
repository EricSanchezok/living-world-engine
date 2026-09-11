import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import type { AgentActionProposal, TransitionProposal } from "../../contracts/model";
import { causalAssertionRepairIssues } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { CausalAssertionValidationError, evaluateProposalCausality } from "../causality";

it("retains sequential failure observations, snapshot binding and typed references without applying a repair", async () => {
  const provider = new ScriptedModelProvider(({ profileId, context }) => deterministicModelOutput(profileId, context));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const state = engine.snapshot;
  const fact = Object.values(state.truth.facts)[0]!;
  fact.value = { kind: "entity", entityId: "player" };
  const action: AgentActionProposal = { id: "controlled-action", actorId: "player", baseRevision: state.revision,
    rawText: "Walk to the gate", goal: "Reach the gate", means: null, targetIds: [] };
  const causes = [{ kind: "action" as const, id: action.id }];
  const clock = (value: number) => ({ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value });
  const proposal: TransitionProposal = {
    baseRevision: state.revision, observations: [], decisionRequests: [],
    operations: [
      { kind: "place_entity", entityId: "player", placementId: "gate", causes, assertions: [clock(0)] },
      { kind: "advance_time", seconds: 60, causes, assertions: [clock(60)] },
    ],
    mechanicInvocations: [{ id: "controlled-mechanic", packageId: "controlled", ruleId: "controlled", input: {}, causes, assertions: [clock(60)] }],
    events: [{ id: "controlled-event", step: 1, description: "Arrived", impact: "ordinary", causes, assertions: [clock(0)] }],
    outcomes: [{ id: "controlled-outcome", proposalId: action.id, status: "succeeded", summary: "Arrived", causeRefs: causes,
      knownAlternatives: [], assertions: [
        { kind: "placement_equals", entityId: "player", placementId: "courtyard" },
        { kind: "fact_matches", factId: fact.id, expected: { kind: "entity", entityId: "keeper" } },
        { kind: "entity_absent", entityId: "player" },
      ] }],
  };
  const binding = { sourceStateHash: contentHash(state), expandedProposalHash: contentHash(proposal) };
  let error: unknown;
  try { evaluateProposalCausality(state, [], [], proposal); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(CausalAssertionValidationError);
  const issues = causalAssertionRepairIssues({ definition, state, evaluationState: state, actions: [action],
    resolutionPlans: [], checkRequests: [], randomRequests: [], proposal,
    failures: (error as CausalAssertionValidationError).failures });
  expect(issues).toHaveLength(6);
  expect(issues.every(issue => issue.path.length === 0 && issue.code === "causal_assertion_failed")).toBe(true);
  const evidence = issues.map(issue => issue.originalValue);
  expect(evidence).toEqual([
    expect.objectContaining({ observed: 0, evaluation: { phase: "before-operation", expandedOperationIndex: 1 }, binding }),
    expect.objectContaining({ observed: 0, evaluation: { phase: "base-state" }, binding }),
    expect.objectContaining({ observed: 60, evaluation: { phase: "after-all-operations" }, binding }),
    expect.objectContaining({ observed: { known: true, placementRef: "ref:placement:gate" },
      evaluation: { phase: "after-all-operations" }, actionRef: "ref:action:controlled-action", binding }),
    expect.objectContaining({ observed: { kind: "entity", entityRef: "ref:entity:player" },
      assertion: { kind: "fact_matches", factRef: `ref:fact:${fact.id}`, expected: { kind: "entity", entityRef: "ref:entity:keeper" } } }),
    expect.objectContaining({ observed: { present: true }, assertion: { kind: "entity_absent", entityRef: "ref:entity:player" } }),
  ]);
  expect(JSON.stringify(issues)).not.toMatch(/"(?:entityId|placementId|factId)":/);
  expect(contentHash(state)).toBe(binding.sourceStateHash);
  expect(contentHash(proposal)).toBe(binding.expandedProposalHash);
});
