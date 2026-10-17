import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldTemplate, parseWorldTemplate, buildWorldDefinition } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer } from "../../engine/testing/direct-provider";
import { projectAgentPerspective } from "../../engine/cognition/agent-perspective";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { quantityId } from "../../engine/runtime/runtime-id";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

function richTemplate() {
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  const origin = template.participation!.origins[0]!;
  const belief = (localId: string, name: string, canonicalId: string) => ({
    local_entities: [{ id: localId, name, description: `${name}是多年相识的人。`, status: "observed" }],
    evidence: [], claims: [], bindings: [{ local_entity_id: localId, canonical_entity_ids: [canonicalId] }],
  });
  return parseWorldTemplate({ ...template, participation: { origins: [{ ...origin, initialization: {
    entities: [
      { id: "family-chest", kind: "container", name: "家用钱箱", description: "家庭共有的存款。", placement: "courtyard",
        quantities: [{ definition_id: "spirit-stone", amount: 40 }],
        facts: [{ id: "family-chest-owner", predicate: "owned-by", value: { kind: "entity", entityId: "keeper" },
          description: "父亲管理的钱箱，不属于孩子的个人库存。", access: { kind: "private" } }] },
      { id: "apprentice", kind: "person", name: "师弟", description: "从小一起学艺。", placement: "courtyard",
        agent: { id: "apprentice", model_profiles: template.manifest.model_profiles,
          character: { persona: { summary: "希望继续与师兄学艺。" } },
          belief: { local_entities: [
            { id: "self", name: "我", description: "师弟。", status: "observed" },
            { id: "sibling", name: "师兄", description: "多年的同门。", status: "observed" }], evidence: [], claims: [],
            bindings: [{ local_entity_id: "self", canonical_entity_ids: ["apprentice"] },
              { local_entity_id: "sibling", canonical_entity_ids: ["$participant"] }] } } },
    ],
    facts: [
      { id: "parent-child", subject_id: "keeper", predicate: "parent-of", value: { kind: "entity", entityId: "$participant" },
        description: "守门人是玩家的父亲。", access: { kind: "private" } },
      { id: "unexamined-root", subject_id: "$participant", predicate: "spirit-root", value: { kind: "boolean", value: true },
        description: "尚未检测的资质。", access: { kind: "private" } },
    ],
    cognition: [
      { agent_id: "$participant", belief: belief("father", "父亲", "keeper") },
      { agent_id: "keeper", belief: belief("child", "孩子", "$participant") },
    ],
    character: { commitments: [{ id: "family-duty", description: "帮助父亲照顾家庭。", priority: 0.6, subject_ids: ["father"] }] },
  } }, {
    kind: "existing", id: "keeper-identity", agent_id: "keeper", title: "守门人", fantasy: "继续自己的人生。",
    description: "接管庭院中现有的守门人。", default_goal: "自己决定去留。", relationship_hooks: [], risks: [],
    fallback_arrival: "夜色笼罩着石门，你可以继续值守，也可以作出其他选择。",
  }] } });
}

describe("authored participation through the persistent host", () => {
  it("loads and commits a family, property, an additional Agent and reciprocal cognition, then replays the result", async () => {
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q, "none")])));
    await f.registry.capture();
    const world = buildWorldDefinition(richTemplate(), { modelCatalog: f.catalog });
    const baseline = structuredClone(world.initialState);
    const root = mkdtempSync(path.join(tmpdir(), "origin-family-"));
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: "courtyard-wanderer",
        displayName: "小林", appearance: "青衣。", motivation: "希望成为富翁。" } });
      const document = database.readInstance(created.summary.id).document;
      const state = document.state, id = created.participants[0]!.agentId;
      expect(Object.keys(state.agents)).toHaveLength(Object.keys(baseline.agents).length + 2);
      expect(state.agents[id]!.bindings.father!.canonicalEntityIds).toEqual(["keeper"]);
      expect(state.agents.keeper!.bindings.child!.canonicalEntityIds).toEqual([id]);
      expect(state.agents.apprentice!.bindings.sibling!.canonicalEntityIds).toEqual([id]);
      expect(state.agents[id]!.character.commitments["family-duty"]!.subjectIds).toEqual(["father"]);
      expect(state.truth.facts["unexamined-root"]!.subjectId).toBe(id);
      expect(JSON.stringify(projectAgentPerspective(state, state.agents[id]!))).not.toContain("spirit-root");
      expect(state.truth.quantities[quantityId(state.worldHash, "spirit-stone", "family-chest")]!.amount).toBe(40);
      expect(state.truth.quantities[quantityId(state.worldHash, "spirit-stone", "keeper")]).toEqual(baseline.truth.quantities[quantityId(state.worldHash, "spirit-stone", "keeper")]);
      expect(document.participants[created.participants[0]!.id]!.arrival.knownEntities.some(entity => entity.localEntityId === "father")).toBe(true);
      expect(document.policyBindings.apprentice!.kind).toBe("model");
      expect(state.admissions).toHaveLength(1);
      expect(replaySimulationState(state)).toEqual(state);
      expect(world.initialState).toEqual(baseline);
      expect(f.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("enters an existing unique identity without an admission, changed inventory or leaked canonical bindings", async () => {
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q, "none")])));
    await f.registry.capture();
    const world = buildWorldDefinition(richTemplate(), { modelCatalog: f.catalog });
    const root = mkdtempSync(path.join(tmpdir(), "origin-existing-"));
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const options = host.worldStartOptions(world.id);
      expect(options.origins.find(origin => origin.id === "keeper-identity")).toMatchObject({ kind: "existing", identityName: "守门人" });
      expect(JSON.stringify(options)).not.toContain("canonicalEntityIds");
      const start = { kind: "origin" as const, originId: "keeper-identity", displayName: "守门人", appearance: "", motivation: "" };
      await expect(host.createInstance({ worldId: world.id, start: { ...start, motivation: "我已拥有所有财产。" } })).rejects.toThrow("authored");
      expect(host.listInstances()).toHaveLength(0);
      const created = await host.createInstance({ worldId: world.id, start });
      const document = database.readInstance(created.summary.id).document;
      expect(created.participants[0]!.agentId).toBe("keeper");
      expect(document.state.truth).toEqual(world.initialState.truth);
      expect(document.state.agents).toEqual(world.initialState.agents);
      expect(document.state.admissions).toEqual([]);
      expect(document.state.revision).toBe(0);
      expect(document.policyBindings.keeper!.kind).toBe("external");
      expect(replaySimulationState(document.state)).toEqual(document.state);
      expect(f.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["missing-relative", "duplicate-cognition", "duplicate-binding", "existing-entity", "unknown-profile", "missing-existing-identity"])("rejects %s while loading, before persistence", scenario => {
    const template = richTemplate(), origin = template.participation!.origins[0]!;
    if (origin.kind !== "create") throw new Error("fixture requires a created origin");
    const seed = origin.initialization!;
    if (scenario === "missing-relative") seed.facts[0]!.value = { kind: "entity", entityId: "absent" };
    if (scenario === "duplicate-cognition") seed.cognition[1]!.belief.local_entities[0]!.id = "self";
    if (scenario === "duplicate-binding") seed.cognition[0]!.belief.bindings.push(structuredClone(seed.cognition[0]!.belief.bindings[0]!));
    if (scenario === "existing-entity") seed.entities[0]!.id = "keeper";
    if (scenario === "unknown-profile") seed.entities[1]!.agent!.model_profiles.decision = "absent-profile";
    if (scenario === "missing-existing-identity") {
      const existing = template.participation!.origins[1]!;
      if (existing.kind === "existing") existing.agent_id = "absent";
    }
    expect(() => buildWorldDefinition(template, { modelCatalog: directTestProvider(() => ({})).catalog })).toThrow();
  });
});
