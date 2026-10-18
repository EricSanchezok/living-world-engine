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
function assembled() {
  return assembleRegionalModules(read("modules/opening-sample.json"), read("claims/opening-sample.json"),
    regions.map(id => ({
      module: read(`regions/${id}/module.json`), claims: read(`regions/${id}/claims.json`), review: read(`regions/${id}/review.json`),
    })));
}
function archive(): Buffer {
  const template = parseWorldTemplate(assembled().module.template), zip = new AdmZip();
  const files: Array<[string, unknown]> = [["script.yaml", template.manifest], ["laws.yaml", template.laws],
    ["mechanics.yaml", template.mechanics], ["participation.yaml", template.participation],
    ...template.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as [string, unknown])];
  for (const [file, contents] of files) zip.addFile(file, Buffer.from(stringify(contents)));
  return zip.toBuffer();
}

describe("Fanren spirit human territories", () => {
  let worldArchive: Buffer;
  // Reuse only immutable input bytes; each case still imports into its own fresh database.
  beforeAll(() => { worldArchive = archive(); }, 60_000);

  it("keeps historical structures, explicit original lives and exact editorial approvals separate", () => {
    const region = read("regions/spirit-human-three/module.json"), claims = read("regions/spirit-human-three/claims.json"), review = read("regions/spirit-human-three/review.json");
    expect(review.moduleHash).toBe(contentHash(region));
    expect(review.claimsHash).toBe(contentHash(claims));
    const all = parseWorldTemplate(assembled().module.template).entities;
    expect(all.find(entity => entity.id === "spirit-tianyuan-capital")?.name).toBe("天元城");
    expect(all.find(entity => entity.id === "tianyuan-city")?.name).toBe("天渊城");
    const laterNamedEntities = all.filter(entity => /^(canon-zhang-kui|tiandong-firm|future-spirit3)/.test(entity.id));
    expect(laterNamedEntities.map(entity => entity.id)).toEqual(["future-spirit3-jinyu-sect"]);
    expect(laterNamedEntities[0]?.kind).toBe("social-group");
    expect(laterNamedEntities[0]?.agent).toBeUndefined();
    const supplement = read("regions/global-source-detail/module.json");
    const supplementClaims = read("regions/global-source-detail/claims.json");
    expect(supplement.provenance["entity:future-spirit3-jinyu-sect"]).toContain("global-detail-current-institutions-and-custody");
    expect(supplementClaims.find((claim: { id: string }) => claim.id === "global-detail-current-institutions-and-custody"))
      .toEqual(expect.objectContaining({ classification: "original", validAtOpening: true, status: "reviewed" }));
    for (const entity of region.entities as typeof all) {
      expect(entity.description).not.toMatch(/原著|原文|原创|标定|T0|第[一二三四五六七八九十]+章/);
      expect(region.provenance[`entity:${entity.id}`]?.length).toBeGreaterThan(0);
      for (const fact of entity.facts) expect(region.provenance[`fact:${fact.id}`]?.length).toBeGreaterThan(0);
      if (entity.agent) {
        expect(entity.agent.belief.claims.some(claim => claim.predicate === "learned-skill")).toBe(true);
        expect(entity.facts.some(fact => fact.predicate === "spiritual-root")).toBe(true);
      }
    }
    expect(claims.find((claim: { id: string }) => claim.id === "spirit3-root-herb-possibility")?.classification).toBe("testimony");
    expect(claims.find((claim: { id: string }) => claim.id === "spirit3-local-day-calibration")?.classification).toBe("calibration");
  });

  it.each(["han-li", "spirit-merchant", "spirit-array-master"])("imports %s into one world with usable body training, real inventory and private investigations", async originId => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-spirit-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(Buffer.from(worldArchive), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId, displayName: originId === "han-li" ? "韩立" : "归客", appearance: "", motivation: originId === "han-li" ? "" : "看看周围真实生活，自己决定以后。" } });
      const state = database.readInstance(created.summary.id).document.state, player = created.participants[0]!.agentId;
      const knows = (subject: string, target: string) => Object.values(state.agents[subject]!.bindings).some(binding => binding.canonicalEntityIds.includes(target));
      const quantity = (definition: string, subject: string) => state.truth.quantities[quantityId(state.worldHash, definition, subject)]?.amount ?? 0;
      expect(state.truth.placements["spirit-loader-glove"]).toBe("spirit-repair-yard");
      expect(quantity("low-stone", "spirit-loader-glove")).toBe(0);
      expect(quantity("low-stone", "spirit-tool-stock")).toBe(90);
      expect(quantity("herb-packet", "spirit-body-medicine")).toBe(10);
      expect(quantity("low-stone", "spirit-yard-repair-funds")).toBe(40);
      expect(quantity("low-stone", "spirit-land-survey-fund")).toBe(180);
      expect(state.truth.facts["spirit-body-teacher-spiritual-root"]?.value).toEqual({ kind: "text", value: "无灵根" });
      expect(state.truth.facts["spirit-body-teacher-learned-skill"]?.value).toEqual(expect.objectContaining({ kind: "text", value: expect.stringContaining("负重基本功") }));
      expect(Object.values(state.truth.ratings).find(rating => rating.entityId === "spirit-body-teacher" && rating.definitionId === "cultivation")?.value).toBe(0);
      expect(Object.values(state.truth.ratings).find(rating => rating.entityId === "spirit-body-teacher" && rating.definitionId === "force")?.value).toBe(4);
      expect(knows("spirit-device-smith", "spirit-device-apprentice")).toBe(true);
      expect(knows("spirit-device-apprentice", "spirit-device-smith")).toBe(true);
      expect(knows("spirit-body-teacher", "spirit-body-student")).toBe(true);
      expect(knows("spirit-body-student", "spirit-body-teacher")).toBe(true);
      expect(knows("spirit-yard-steward", "qinghe-store")).toBe(true);
      expect(knows("spirit-yard-steward", player)).toBe(false);
      const perspective = JSON.stringify(projectAgentPerspective(state, state.agents[player]!));
      expect(perspective).not.toContain("第三道引流铜线");
      expect(perspective).not.toContain("旧水线刻记偏向东石内侧");
      expect(perspective).not.toContain("梅沙");
      expect(JSON.stringify(projectAgentPerspective(state, state.agents["spirit-device-smith"]!))).not.toContain("第三道引流铜线被潮气侵蚀");
      const reachable = new Set(["tianyuan-city"]);
      for (let i = 0; i < 30; i++) for (const fact of Object.values(state.truth.facts)) {
        if (fact.predicate === "route-to" && fact.value.kind === "entity" && reachable.has(fact.subjectId)) reachable.add(fact.value.entityId);
      }
      for (const place of ["qinghe-store", "listening-spring", "spirit-repair-yard", "spirit-body-school", "spirit-anyuan-city", "spirit-yuyang-city", "spirit-huangliang-cave", "spirit-shengshan-market", "spirit-xuanwu-harbor", "spirit-tianling-market"]) expect(reachable).toContain(place);
      expect(reachable).not.toContain("shanbian-village");
      expect(replaySimulationState(state)).toEqual(state);
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  }, 60_000);
});
