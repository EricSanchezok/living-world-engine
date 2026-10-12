import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectAgentPerspective } from "../../engine/cognition/agent-perspective";
import type { WorldFact } from "../../engine/contracts/model";
import { createTestModelCatalog } from "../../engine/testing/model-provider";
import { loadWorldScript } from "../../script/world-loader";
import { buildAgentPerspectiveGraph } from "../_lib/agent-perspective-graph";

function perspective() {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    modelCatalog: createTestModelCatalog(),
  });
  const state = structuredClone(definition.initialState);
  const fact: WorldFact = {
    id: "key-resonance",
    subjectId: "player",
    predicate: "resonates-with",
    value: { kind: "entity", entityId: "key" },
    description: "旅人与铜钥匙之间存在某种共鸣。",
    access: { kind: "agents", agentIds: ["player"] },
    provenance: [{ kind: "world_seed", id: definition.contentHash }],
  };
  state.truth.facts[fact.id] = fact;
  state.agents.player.character.goals.road = {
    id: "road",
    description: "找到石门后的道路",
    priority: 0.8,
    progress: 0,
    targetIds: [],
    motivatedByIds: [],
    status: "active",
    createdAtStep: 0,
    updatedAtStep: 0,
    evidenceIds: [],
  };
  return projectAgentPerspective(state, state.agents.player);
}

describe("Agent Perspective relationship graph", () => {
  it("renders open predicates, containment, and subjective stances by structure", () => {
    const graph = buildAgentPerspectiveGraph(perspective());

    expect(graph.nodes.find((node) => node.id === graph.selfRef)?.kind).toBe("self");
    expect(graph.relations).toContainEqual(expect.objectContaining({
      origin: "containment",
      kind: "exact",
      target: "local:copper-key",
    }));
    expect(graph.relations).toContainEqual(expect.objectContaining({
      origin: "fact",
      kind: "exact",
      label: "resonates-with",
    }));
    expect(graph.relations).toContainEqual(expect.objectContaining({
      origin: "claim",
      kind: "suspected",
      label: "authenticity",
    }));
    expect(graph.relations).toContainEqual(expect.objectContaining({
      origin: "goal",
      kind: "believed",
      description: "找到石门后的道路",
    }));
  });

  it("does not invent a meter or a relation for absent structures", () => {
    const view = perspective();
    view.mechanics = { meters: [], quantityCoverage: "complete-current-self-holdings", quantities: [], ratings: [], conditions: [] };
    view.knowledge.containment = [];
    view.knowledge.exactFacts = [];
    view.knowledge.claims = [];
    view.character.attitudes = {};
    view.character.goals = {};
    view.character.commitments = {};

    const graph = buildAgentPerspectiveGraph(view);
    expect(view.mechanics).toEqual({ meters: [], quantityCoverage: "complete-current-self-holdings", quantities: [], ratings: [], conditions: [] });
    expect(graph.relations).toEqual([]);
    expect(graph.nodes.map((node) => node.id)).toContain(graph.selfRef);
  });
});
