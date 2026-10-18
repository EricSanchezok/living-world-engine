import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { contentHash } from "../../src/engine/models/model-audit";
import { quantityId } from "../../src/engine/runtime/runtime-id";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { directTestProvider, nativeAnswer } from "../../src/engine/testing/direct-provider";
import { parseWorldTemplate } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { assembleRegionalModules } from "./regional-composition";

const root = path.resolve("worlds/fanren/authoring");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const regions: string[] = read("coverage/regional-plan.json").modules.map((region: { id: string }) => region.id);
function template() {
  return parseWorldTemplate(assembleRegionalModules(read("modules/opening-sample.json"), read("claims/opening-sample.json"),
    regions.map(id => ({ module: read(`regions/${id}/module.json`), claims: read(`regions/${id}/claims.json`), review: read(`regions/${id}/review.json`) }))).module.template);
}
function archive() {
  const world = template(), zip = new AdmZip();
  const files: Array<[string, unknown]> = [["script.yaml", world.manifest], ["laws.yaml", world.laws],
    ["mechanics.yaml", world.mechanics], ["participation.yaml", world.participation],
    ...world.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as [string, unknown])];
  for (const [file, contents] of files) zip.addFile(file, Buffer.from(stringify(contents)));
  return zip.toBuffer();
}

describe("Fanren demon territories and Tianyuan civil life", () => {
  let worldArchive: Buffer;
  // Reuse only immutable input bytes; each case still imports into its own fresh database.
  beforeAll(() => { worldArchive = archive(); }, 60_000);

  it("binds reviews to complete modules while reserving cross-realm souls without duplicate actors", () => {
    for (const id of ["spirit-demon-seven", "spirit-tianyuan"]) {
      const region = read(`regions/${id}/module.json`), claims = read(`regions/${id}/claims.json`), review = read(`regions/${id}/review.json`);
      expect(review.moduleHash).toBe(contentHash(region));
      expect(review.claimsHash).toBe(contentHash(claims));
      for (const entity of region.entities) {
        expect(entity.description).not.toMatch(/原著|原创|T0|标定/);
        expect(region.provenance[`entity:${entity.id}`]?.length).toBeGreaterThan(0);
        for (const fact of entity.facts) expect(region.provenance[`fact:${fact.id}`]?.length).toBeGreaterThan(0);
      }
    }
    const all = template().entities;
    expect(all.filter(entity => entity.id === "canon-dongtian-rat-king")).toHaveLength(1);
    expect(all.filter(entity => entity.id === "canon-ao-xiao")).toHaveLength(1);
    expect(all.filter(entity => entity.id === "canon-mo-jian-li")).toHaveLength(1);
    const demonEntities = read("regions/spirit-demon-seven/module.json").entities as typeof all;
    expect(demonEntities.some(entity => ["canon-linglong", "canon-xueling-soul", "canon-longmeng-soul", "canon-yin-yue"].includes(entity.id))).toBe(false);
    expect(all.filter(entity => entity.id === "canon-xueling-soul")).toHaveLength(1);
    expect(all.filter(entity => entity.id === "canon-longmeng-soul")).toHaveLength(1);
    expect(all.some(entity => entity.id === "canon-yin-yue")).toBe(false);
    const subjects = read("regions/spirit-demon-seven/subjects.json");
    expect(subjects.find((subject: { id: string }) => subject.id === "canon-xueling-soul")?.aliases).toContain("银月");
    expect(subjects.find((subject: { id: string }) => subject.id === "demon-seventh-unidentified")?.reason).toContain("原创");
    expect(all.find(entity => entity.id === "demon-sunset-city")?.placement).not.toBe(all.find(entity => entity.id === "spirit-sunset-human-city")?.placement);
  });

  it.each(["spirit-merchant", "spirit-array-master"])("imports %s with finite resources, bounded knowledge and real investigation sites", async originId => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-demon-city-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(Buffer.from(worldArchive), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId, displayName: "行舟", appearance: "", motivation: "先认识身边的人，再决定接下来做什么。" } });
      const state = database.readInstance(created.summary.id).document.state, player = created.participants[0]!.agentId;
      const knows = (subject: string, target: string) => Object.values(state.agents[subject]!.bindings).some(binding => binding.canonicalEntityIds.includes(target));
      const quantity = (definition: string, subject: string) => state.truth.quantities[quantityId(state.worldHash, definition, subject)]?.amount ?? 0;
      expect(quantity("herb-packet", "demon-fox-herb-cargo")).toBe(18);
      expect(quantity("craft-material", "demon-rat-exposed-ore")).toBe(12);
      expect(quantity("low-stone", "tianyuan-guard-maintenance-fund")).toBe(200);
      expect(quantity("high-stone", "tianyuan-transport-fuel")).toBe(4);
      expect(quantity("craft-material", "tianyuan-traveler-cargo")).toBe(8);
      for (let dose = 1; dose <= 6; dose++) expect(state.truth.placements[`tianyuan-dust-pill-${dose}`]).toBe("tianyuan-dust-stock");
      expect(Object.keys(state.truth.placements).filter(id => /^tianyuan-dust-pill-/.test(id))).toHaveLength(6);
      expect(state.truth.placements["tianyuan-dust-stock"]).toBe("tianyuan-dust-dispensary");
      expect(state.truth.placements["tianyuan-patrol-scout"]).toBe("tianyuan-stream-gully");
      expect(state.truth.placements["tianyuan-demon-traveler"]).toBe("tianyuan-stream-gully");
      expect(knows("tianyuan-patrol-chief", "tianyuan-patrol-scout")).toBe(true);
      expect(knows("tianyuan-patrol-scout", "tianyuan-patrol-chief")).toBe(true);
      expect(knows("demon-fox-herbalist", "demon-nine-carrier")).toBe(true);
      expect(knows("demon-nine-carrier", "demon-fox-herbalist")).toBe(true);
      expect(knows("canon-mo-jian-li", "canon-ao-xiao")).toBe(true);
      expect(knows("canon-ao-xiao", "canon-mo-jian-li")).toBe(true);
      expect(knows("canon-jinyue-monk", "canon-leiluo-zhenren")).toBe(true);
      expect(knows("canon-leiluo-zhenren", "canon-jinyue-monk")).toBe(true);
      expect(knows("spirit-guard-captain", "canon-jinyue-monk")).toBe(true);
      expect(state.truth.placements["demon-eagle-delayed-letter"]).toBe("demon-eagle-courier");
      expect(state.truth.placements["tianyuan-dust-outer-key"]).toBe("tianyuan-dust-keeper");
      expect(state.truth.placements["tianyuan-dust-inner-key"]).toBe("tianyuan-dust-physician");
      expect(quantity("low-stone", "demon-flood-craftsman")).toBe(150);
      expect(quantity("craft-material", "demon-flood-order-materials")).toBe(5);
      expect(quantity("mid-stone", "tianyuan-holy-maintenance-fund")).toBe(80);
      expect(quantity("craft-material", "tianyuan-holy-maintenance-fund")).toBe(12);
      const attendantView = JSON.stringify(projectAgentPerspective(state, state.agents["tianyuan-mo-attendant"]!));
      expect(attendantView).not.toContain("想交换修行近况并谈一谈跨界旧闻");
      expect(JSON.stringify(projectAgentPerspective(state, state.agents["canon-ao-xiao"]!))).toContain("想交换修行近况并谈一谈跨界旧闻");
      expect(knows("canon-mo-jian-li", player)).toBe(false);
      expect(knows("canon-ao-xiao", player)).toBe(false);
      const playerView = JSON.stringify(projectAgentPerspective(state, state.agents[player]!));
      expect(playerView).not.toContain("旧导水槽被落石堵塞");
      expect(playerView).not.toContain("昨日积水冲松一侧桥墩");
      const chiefView = JSON.stringify(projectAgentPerspective(state, state.agents["tianyuan-patrol-chief"]!));
      expect(chiefView).not.toContain("自己看见桥墩晃动后跌倒");
      expect(chiefView).not.toContain("原著");
      expect(JSON.stringify(projectAgentPerspective(state, state.agents["canon-ao-xiao"]!))).not.toContain("天澜圣兽本体");
      const reachable = new Set(["tianyuan-city"]);
      for (let iteration = 0; iteration < 30; iteration++) for (const fact of Object.values(state.truth.facts)) {
        if (fact.predicate === "route-to" && fact.value.kind === "entity" && reachable.has(fact.subjectId)) reachable.add(fact.value.entityId);
      }
      for (const place of ["demon-nine-immortal-market", "demon-rat-shallow-tunnel", "demon-sunset-city", "demon-seventh-town", "tianyuan-stream-gully", "tianyuan-vacant-cave-a", "tianyuan-dust-dispensary"]) expect(reachable).toContain(place);
      expect(reachable).not.toContain("shanbian-village");
      expect(replaySimulationState(state)).toEqual(state);
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
});
