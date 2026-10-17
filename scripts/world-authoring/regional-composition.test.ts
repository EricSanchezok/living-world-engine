import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldTemplate, buildWorldDefinition } from "../../src/script/world-loader";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { contentHash } from "../../src/engine/models/model-audit";
import { assembleRegionalModules } from "./regional-composition";

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
