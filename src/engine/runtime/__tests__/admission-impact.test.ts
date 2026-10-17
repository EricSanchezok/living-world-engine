import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { DeterministicModelProvider } from "../../testing/model-provider";
import { SimulationEngine } from "../simulation";
import {
  computeAdmissionImpact,
  type AdmissionCandidateState,
} from "../admission-impact";
import type { AgentState, WorldEntity } from "../../contracts/model";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { CanonicalCommitter } from "../canonical-committer";
import { replaySimulationState } from "../transaction";
import { emptyAdmissionAdditions } from "../admission-additions";
import { quantityId } from "../runtime-id";
import { projectAgentPerspective } from "../../cognition/agent-perspective";

function candidateFor(
  source: Readonly<import("../../contracts/model").SimulationState>,
  placementId: string | null,
): AdmissionCandidateState {
  const template = structuredClone(source.agents.keeper) as AgentState;
  const selfBinding = Object.values(template.bindings).find((binding) =>
    binding.canonicalEntityIds.includes(template.entityId));
  if (!selfBinding) throw new Error("fixture Agent has no self binding");
  template.id = "new-agent";
  template.entityId = "new-agent";
  template.nextAction = null;
  template.bindings[selfBinding.localEntityId] = {
    localEntityId: selfBinding.localEntityId,
    canonicalEntityIds: ["new-agent"],
  };
  const entity: WorldEntity = {
    id: "new-agent",
    kind: "person",
    name: "新来者",
    description: "刚刚进入世界的人。",
    lifecycle: "active",
    createdAtStep: source.step,
  };
  return {
    entity,
    placementId,
    agent: template,
    meters: [],
    quantities: [],
    ratings: [],
    conditions: [],
    additions: emptyAdmissionAdditions(),
  };
}

describe("admission impact proof", () => {
  it("reuses prepared actions when the new Agent is outside every perspective", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const algorithm = new EagerReferenceAlgorithm(provider);
    const realEngine = new SimulationEngine(definition, algorithm);
    await realEngine.bootstrapAgents();
    const source = realEngine.snapshot;
    const impact = computeAdmissionImpact(source, candidateFor(source, null));
    expect(impact.invalidatedAgentIds).toEqual([]);
    expect(impact.reusedActions).toHaveLength(Object.keys(source.agents).length);
    expect(impact.reusedActions.every((action) => action.baseRevision === source.revision + 1)).toBe(true);
    expect(impact.reusedActions.every((action) => action.rawText.length > 0)).toBe(true);
  });

  it("invalidates the Agent whose visible containment changes", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const algorithm = new EagerReferenceAlgorithm(provider);
    const engine = new SimulationEngine(definition, algorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const impact = computeAdmissionImpact(source, candidateFor(source, source.agents.keeper!.entityId));
    expect(impact.invalidatedAgentIds).toContain("keeper");
    expect(impact.reusedActions.map((action) => action.actorId)).not.toContain("keeper");
  });

  it("rebases retained actions and replays the admission atomically", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const priorIds = Object.values(source.agents)
      .flatMap((agent) => agent.nextAction ? [agent.nextAction.id] : [])
      .sort();
    const admitted = new CanonicalCommitter().admit(source, candidateFor(source, null));

    expect(admitted.committed.invalidatedActionIds).toEqual(priorIds);
    expect(admitted.committed.reusedActions.map((action) => action.actorId)).toEqual(
      Object.keys(source.agents).sort(),
    );
    expect(admitted.state.revision).toBe(source.revision + 1);
    for (const action of admitted.committed.reusedActions) {
      expect(admitted.state.agents[action.actorId]!.nextAction).toEqual(action);
      expect(action.baseRevision).toBe(admitted.state.revision);
      expect(action.id).not.toBe(source.agents[action.actorId]!.nextAction!.id);
    }
    expect(() => replaySimulationState(admitted.state)).not.toThrow();
  });

  it("fails closed when a cognitive perspective cannot be projected", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const candidate = candidateFor(source, null);
    const selfBinding = Object.values(source.agents.keeper!.bindings).find((binding) =>
      binding.canonicalEntityIds.includes(source.agents.keeper!.entityId));
    if (!selfBinding) throw new Error("fixture Agent has no self binding");
    delete source.agents.keeper!.bindings[selfBinding.localEntityId];

    const impact = computeAdmissionImpact(source, candidate);
    expect(impact.invalidatedAgentIds).toContain("keeper");
    expect(impact.reasons.keeper).toContain("cognitive_input_inconclusive");
  });

  it("admits property and reciprocal recognition atomically without revealing a hidden qualification", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const candidate = candidateFor(source, null);
    candidate.additions.entities.push({ entity: { id: "family-chest", kind: "container", name: "家用钱箱", description: "家庭共有的钱箱。", lifecycle: "active", createdAtStep: 0 }, placementId: "courtyard" });
    candidate.additions.quantities.push({ id: quantityId(source.worldHash, "spirit-stone", "family-chest"), definitionId: "spirit-stone", holderId: "family-chest", amount: 50 });
    candidate.additions.facts.push(
      { id: "kinship", subjectId: "keeper", predicate: "parent-of", value: { kind: "entity", entityId: "new-agent" }, description: "守门人是新来者的父亲。", access: { kind: "private" }, provenance: [{ kind: "world_seed", id: source.worldHash }] },
      { id: "hidden-qualification", subjectId: "new-agent", predicate: "spirit-root", value: { kind: "boolean", value: true }, description: "尚未检测的资质。", access: { kind: "private" }, provenance: [{ kind: "world_seed", id: source.worldHash }] },
    );
    candidate.additions.cognition.push({ agentId: "keeper", belief: {
      localEntities: { child: { id: "child", name: "孩子", description: "自己养大的孩子。", status: "observed" } },
      evidence: { upbringing: { id: "upbringing", kind: "observation", description: "多年共同生活。", sourceId: null, step: 0 } },
      claims: { "my-child": { id: "my-child", subjectId: "self", predicate: "parent-of", value: { kind: "local_entity", localEntityId: "child" }, description: "这是自己的孩子。", stance: "believed", confidence: 1, evidenceIds: ["upbringing"] } },
    }, bindings: { child: { localEntityId: "child", canonicalEntityIds: ["new-agent"] } } });
    candidate.additions.cognition.push({ agentId: "new-agent", belief: {
      localEntities: { father: { id: "father", name: "父亲", description: "在石门值守的父亲。", status: "observed" } }, evidence: {}, claims: {},
    }, bindings: { father: { localEntityId: "father", canonicalEntityIds: ["keeper"] } } });

    const admitted = new CanonicalCommitter().admit(source, candidate);
    expect(admitted.committed.reusedActions.map(action => action.actorId)).not.toContain("keeper");
    expect(admitted.state.agents.keeper!.belief.claims["my-child"]!.value).toEqual({ kind: "local_entity", localEntityId: "child" });
    expect(admitted.state.agents["new-agent"]!.belief.localEntities.father!.name).toBe("父亲");
    expect(Object.values(admitted.state.truth.quantities).find(q => q.holderId === "family-chest")?.amount).toBe(50);
    expect(Object.values(admitted.state.truth.quantities).some(q => q.holderId === "new-agent")).toBe(false);
    expect(JSON.stringify(projectAgentPerspective(admitted.state, admitted.state.agents["new-agent"]!))).not.toContain("spirit-root");
    expect(() => replaySimulationState(admitted.state)).not.toThrow();
    expect(source.truth.entities["new-agent"]).toBeUndefined();
    expect(source.agents.keeper!.belief.localEntities.child).toBeUndefined();
  });

  it.each(["identity-collision", "dangling-reference", "existing-cognition-overwrite", "existing-property"])("rejects %s without changing the source", (scenario) => {
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: new DeterministicModelProvider().catalog });
    const source = definition.initialState;
    const before = structuredClone(source);
    const candidate = candidateFor(source, null);
    if (scenario === "identity-collision") candidate.additions.entities.push({ entity: structuredClone(source.truth.entities.keeper!), placementId: null });
    if (scenario === "dangling-reference") candidate.additions.facts.push({ id: "invalid-relative", subjectId: "new-agent", predicate: "relative", value: { kind: "entity", entityId: "absent" }, description: "关系对象缺失。", access: { kind: "private" }, provenance: [] });
    if (scenario === "existing-cognition-overwrite") candidate.additions.cognition.push({ agentId: "keeper", belief: { localEntities: { self: { id: "self", name: "冒充", description: "覆盖既有人物。", status: "observed" } }, claims: {}, evidence: {} }, bindings: {} });
    if (scenario === "existing-property") candidate.additions.quantities.push({ id: quantityId(source.worldHash, "spirit-stone", "keeper"), definitionId: "spirit-stone", holderId: "keeper", amount: 500 });
    expect(() => new CanonicalCommitter().admit(source, candidate)).toThrow();
    expect(source).toEqual(before);
  });
});
