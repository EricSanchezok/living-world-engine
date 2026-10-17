import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldTemplate, buildWorldDefinition } from "../../src/script/world-loader";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { contentHash } from "../../src/engine/models/model-audit";
import { assembleRegionalModules } from "./regional-composition";
import { applyTransitionProposal } from "../../src/engine/runtime/transaction";
import { quantityId } from "../../src/engine/runtime/runtime-id";

function fixture() {
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  const parent = template.entities.find(entity => entity.kind === "location")!;
  const region = { id: "region-east", entities: [{ id: "east-store", name: "East store", kind: "location", description: "A modest local store.",
    placement: parent.id, facts: [{ id: "east-route", predicate: "route-to", value: { kind: "entity", entityId: parent.id }, description: "A footpath leads to the parent place.", access: { kind: "public" } }] }],
    existingEntityFacts: [{ entityId: parent.id, facts: [{ id: "parent-route-east", predicate: "route-to", value: { kind: "entity", entityId: "east-store" }, description: "A footpath leads to the store.", access: { kind: "public" } }] }],
    placements: [], entityDescriptions: [], laws: [],
    provenance: { "entity:east-store": ["east-layout"], "fact:east-route": ["east-layout"], "fact:parent-route-east": ["east-layout"] } as Record<string, string[]> };
  const claims = [{ id: "east-layout", statement: "The store and paths are original additions.", classification: "original", validAtOpening: true,
    learnedTime: "initial", openingReason: "Authored initial infrastructure.", status: "reviewed", dependencies: [], evidence: [] }];
  const review = () => ({ scope: "full", moduleHash: contentHash(region), claimsHash: contentHash(claims), reviewer: "test editorial review", limitations: [] });
  return { base: { id: "base", scope: "sample", template, provenance: {} }, module: region, claims, review, parentId: parent.id };
}

describe("regional deterministic assembly", () => {
  it("merges a distinct resource with finite real stock and rejects redefinition or missing conservation laws", () => {
    const f = fixture();
    const law = f.base.template.laws.laws[0]!.id;
    const definition = { id: "rare-crystal", name: "Rare crystal", unit: "piece", production_law_ids: [law], consumption_law_ids: [law] };
    const region = { ...f.module, entities: f.module.entities.map(entity => ({ ...entity, quantities: [{ definition_id: definition.id, amount: 24 }] })),
      quantityDefinitions: [definition], provenance: { ...f.module.provenance, "quantity:rare-crystal": ["east-layout"] } };
    const packet = () => ({ module: region, claims: f.claims, review: { ...f.review(), moduleHash: contentHash(region) } });
    const merged = assembleRegionalModules(f.base, [], [packet()]);
    const world = buildWorldDefinition(merged.module.template, { modelCatalog: loadModelCatalog(path.resolve("config/models.yaml")) });
    expect(world.initialState.truth.quantities[quantityId(world.contentHash, definition.id, "east-store")]!.amount).toBe(24);
    expect(merged.module.provenance.mechanics).toEqual(["east-layout"]);
    expect(f.base.template.mechanics.quantities.some(quantity => quantity.id === definition.id)).toBe(false);
    definition.production_law_ids = ["nonexistent-law"];
    expect(() => assembleRegionalModules(f.base, [], [packet()])).toThrow();
    definition.production_law_ids = [law];
    definition.id = f.base.template.mechanics.quantities[0]!.id;
    expect(() => assembleRegionalModules(f.base, [], [packet()])).toThrow("duplicate regional quantity definition");
  });
  it("imports a sourced regional cycle and advances its real phase without overwriting another module", () => {
    const f = fixture();
    const property = { id: "east-market-cycle", subject_id: "east-store", predicate: "market-phase",
      access: { kind: "public" as const }, period_seconds: 100, initial_phase_seconds: 50,
      phases: [{ starts_at_seconds: 0, value: { kind: "text" as const, value: "open" }, description: "The market is open." },
        { starts_at_seconds: 10, value: { kind: "text" as const, value: "closed" }, description: "The market is closed." }] };
    const provenance: Record<string, string[]> = { ...f.module.provenance, "periodic:east-market-cycle": ["east-layout"] };
    const region = { ...f.module, periodicProperties: [property], provenance };
    const packet = () => ({ module: region, claims: f.claims, review: { ...f.review(), moduleHash: contentHash(region) } });
    const merged = assembleRegionalModules(f.base, [], [packet()]);
    const world = buildWorldDefinition(merged.module.template, { modelCatalog: loadModelCatalog(path.resolve("config/models.yaml")) });
    expect(world.initialState.truth.facts[property.id]!.value).toEqual({ kind: "text", value: "closed" });
    const advanced = applyTransitionProposal(world.initialState, { baseRevision: 0, outcomes: [], mechanicInvocations: [], observations: [], decisionRequests: [], events: [],
      operations: [{ kind: "advance_time", seconds: 50, causes: [{ kind: "mechanic", id: "cycle-check" }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }] }] });
    expect(advanced.truth.facts[property.id]!.value).toEqual({ kind: "text", value: "open" });
    expect(merged.module.provenance.mechanics).toEqual(["east-layout"]);
    expect(f.base.template.mechanics.periodic_properties).toEqual([]);
    const second = { id: "second-region", entities: [], existingEntityFacts: [], placements: [], entityDescriptions: [], laws: [],
      periodicProperties: [property], provenance: { "periodic:east-market-cycle": ["east-layout"] } };
    expect(() => assembleRegionalModules(f.base, [], [packet(), { module: second, claims: [],
      review: { ...f.review(), moduleHash: contentHash(second), claimsHash: contentHash([]) } }])).toThrow("duplicate regional periodic property");
    delete region.provenance["periodic:east-market-cycle"];
    expect(() => assembleRegionalModules(f.base, [], [packet()])).toThrow("missing regional provenance");
  });
  it("adds only an existing actor's sourced regional knowledge and refuses overwrites", () => {
    const f = fixture(), actor = f.base.template.entities.find(entity => entity.agent?.id === "player")!;
    const before = contentHash(f.base);
    const belief = { local_entities: [{ id: "east-contact", name: "East store", description: "Visited before the opening.", status: "observed" }],
      evidence: [{ id: "east-visit", kind: "observation", description: "A previous visit.", sourceId: null, step: 0 }],
      claims: [], bindings: [{ local_entity_id: "east-contact", canonical_entity_ids: ["east-store"] }] };
    const region = { ...f.module, agentCognition: [{ agent_id: "player", belief }],
      provenance: { ...f.module.provenance, "cognition:player": ["east-layout"] } };
    const packet = () => ({ module: region, claims: f.claims, review: { ...f.review(), moduleHash: contentHash(region) } });
    const merged = assembleRegionalModules(f.base, [], [packet()]);
    const world = buildWorldDefinition(merged.module.template, { modelCatalog: loadModelCatalog(path.resolve("config/models.yaml")) });
    expect(world.initialState.agents.player!.bindings["east-contact"]!.canonicalEntityIds).toEqual(["east-store"]);
    for (const agent of Object.values(world.initialState.agents).filter(agent => agent.id !== "player")) {
      expect(agent.belief.localEntities["east-contact"]).toBeUndefined();
    }
    expect(contentHash(f.base)).toBe(before);
    expect(merged.module.provenance[`entity:${actor.id}`]).toEqual(["east-layout"]);
    belief.local_entities[0]!.id = actor.agent!.belief.local_entities[0]!.id;
    expect(() => assembleRegionalModules(f.base, [], [packet()])).toThrow("cognition identity conflict");
    region.agentCognition[0]!.agent_id = "absent-agent";
    expect(() => assembleRegionalModules(f.base, [], [packet()])).toThrow("cognition owner conflict");
  });
  it("loads real merged routes and retains editorial provenance without mutating the base", () => {
    const f = fixture(), before = contentHash(f.base);
    const merged = assembleRegionalModules(f.base, [], [{ module: f.module, claims: f.claims, review: f.review() }]);
    const world = buildWorldDefinition(merged.module.template, { modelCatalog: loadModelCatalog(path.resolve("config/models.yaml")) });
    expect(world.initialState.truth.placements["east-store"]).toBe(f.parentId);
    expect(world.initialState.truth.facts["parent-route-east"]!.value).toEqual({ kind: "entity", entityId: "east-store" });
    expect(merged.module.provenance["fact:parent-route-east"]).toEqual(["east-layout"]);
    expect(contentHash(f.base)).toBe(before);
  });
  it.each(["review", "duplicate", "future", "missing-provenance", "placement"])("blocks %s conflicts before publishing a combined bundle", kind => {
    const f = fixture(), review = f.review();
    if (kind === "review") f.module.entities[0]!.description = "Unreviewed new detail.";
    if (kind === "future") f.claims[0]!.validAtOpening = false;
    if (kind === "missing-provenance") delete f.module.provenance["fact:east-route"];
    const changedRegion = kind === "placement" ? { ...f.module, placements: [{ entityId: f.parentId, expected: "wrong-place", value: "east-store" }] } : f.module;
    const packet = { module: changedRegion, claims: f.claims, review: kind === "review" ? review : { ...f.review(), moduleHash: contentHash(changedRegion) } };
    expect(() => assembleRegionalModules(f.base, [], kind === "duplicate" ? [packet, packet] : [packet])).toThrow();
  });
});
