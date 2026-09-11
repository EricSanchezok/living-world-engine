import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { buildAgentContext, buildTruthContext } from "../contracts/prompts";
import type { AgentActionProposal, SimulationState } from "../contracts/model";
import { DeterministicModelProvider } from "../testing/model-provider";

const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
  seed: 47, modelCatalog: new DeterministicModelProvider().catalog,
});

function source(bindings: Record<string, string[]>) {
  const state = structuredClone(definition.initialState), agent = state.agents.player!;
  agent.belief.localEntities = Object.fromEntries(["self", "alpha", "beta", "unknown", "group"].map(id =>
    [id, { id, name: "A reported object", description: "Identity cannot be inferred from this label.", status: "reported" as const }]));
  agent.bindings = Object.fromEntries(Object.entries({ self: ["player"], ...bindings }).map(([id, entities]) =>
    [id, { localEntityId: id, canonicalEntityIds: entities }]));
  return state;
}

function truth(state: SimulationState) {
  const action: AgentActionProposal = { id: "inspect", actorId: "player", baseRevision: state.revision,
    rawText: "Inspect alpha and beta", goal: "Inspect the reported objects", means: null,
    targetIds: ["alpha", "beta", "unknown", "group"] };
  return buildTruthContext({ definition, state,
    workset: { state, mode: "full", initialActions: [action], availableActions: [action], assignedActions: [action],
      availableDependencies: [], assignedDependencies: [] },
    reactionRequests: [], reactionDecisions: [], reactionWindow: "closed", committedCheckRequests: [], checkResults: [],
    committedRandomRequests: [], randomResults: [], commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [],
    temporalBoundary: { fromElapsedSeconds: 0, toElapsedSeconds: 1, deltaSeconds: 1,
      reasons: [{ kind: "safety_horizon" }], dueActivityIds: [], dueTimerIds: [], dueConditionIds: [] },
    instanceId: "instance", advanceId: "advance", issues: [], stage: "resolution",
  }) as { state: { actors: Array<Record<string, unknown>>; canonicalTruth: unknown }; referenceCatalog: unknown };
}

it("distinguishes swapped local bindings even when labels, catalog and flattened canonical order are identical", () => {
  const first = truth(source({ alpha: ["gate"], beta: ["key"], unknown: [], group: ["gate", "key"] }));
  const second = truth(source({ beta: ["gate"], alpha: ["key"], unknown: [], group: ["gate", "key"] }));
  expect(first.state.canonicalTruth).toEqual(second.state.canonicalTruth);
  expect(first.referenceCatalog).toEqual(second.referenceCatalog);
  expect(first.state.actors).not.toEqual(second.state.actors);
  expect(first.state.actors[0]).toMatchObject({ localEntityBindings: [
    { localEntityRef: "ref:local_entity:player::alpha", canonicalEntityRefs: ["ref:entity:gate"] },
    { localEntityRef: "ref:local_entity:player::beta", canonicalEntityRefs: ["ref:entity:key"] },
    { localEntityRef: "ref:local_entity:player::group", canonicalEntityRefs: ["ref:entity:gate", "ref:entity:key"] },
    { localEntityRef: "ref:local_entity:player::unknown", canonicalEntityRefs: [] },
  ] });
  expect(first.state.actors[0]!.boundCanonicalEntityRefs).toEqual(second.state.actors[0]!.boundCanonicalEntityRefs);
});

it("keeps exact bindings out of the private AgentMind projection", () => {
  const first = source({ alpha: ["gate"], beta: ["key"] });
  const second = source({ alpha: ["key"], beta: ["gate"] });
  const project = (state: SimulationState) => buildAgentContext({ state, agent: state.agents.player!, observations: [],
    events: [], currentAction: null, currentOutcome: null, instanceId: "instance", advanceId: "advance", issues: [] });
  for (const state of [first, second]) {
    const serialized = JSON.stringify(project(state));
    expect(serialized).not.toContain("canonicalEntityRefs");
    expect(serialized).not.toContain("localEntityBindings");
    expect(serialized).not.toContain("ref:entity:gate");
    expect(serialized).not.toContain("ref:entity:key");
  }
});
