import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { quantityId } from "../../src/engine/runtime/runtime-id";
import { applyTransitionProposal, replaySimulationState } from "../../src/engine/runtime/transaction";
import { directTestProvider, nativeAnswer } from "../../src/engine/testing/direct-provider";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { assembleRegionalModules } from "./regional-composition";

const root = path.resolve("worlds/fanren/authoring");
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const regions: string[] = read("coverage/regional-plan.json").modules.map((region: { id: string }) => region.id);
function archive() {
  const world = assembleRegionalModules(read("modules/opening-sample.json"), read("claims/opening-sample.json"), regions.map(id => ({
    module: read(`regions/${id}/module.json`), claims: read(`regions/${id}/claims.json`), review: read(`regions/${id}/review.json`),
  }))).module.template;
  const zip = new AdmZip();
  for (const [file, data] of [["script.yaml", world.manifest], ["mechanics.yaml", world.mechanics], ["laws.yaml", world.laws],
    ["participation.yaml", world.participation], ...world.entities.map(entity => [`entities/${entity.id}.yaml`, entity])] as Array<[string, unknown]>) {
    zip.addFile(file, Buffer.from(stringify(data)));
  }
  return zip.toBuffer();
}

describe("Fanren reviewed regional state through ZIP import and identity entry", () => {
  it.each(["spirit-merchant", "spirit-array-master"])("preserves social knowledge, real property and conditional passages for %s", async originId => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-cross-region-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(archive(), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId,
        displayName: "远舟", appearance: "", motivation: "先过好眼前的生活。" } });
      const state = database.readInstance(created.summary.id).document.state;
      const knows = (subject: string, target: string) => Object.values(state.agents[subject]!.bindings).some(binding => binding.canonicalEntityIds.includes(target));
      const quantity = (definition: string, subject: string) => state.truth.quantities[quantityId(state.worldHash, definition, subject)]?.amount ?? 0;
      for (const [a, b] of [["fengyuan-yaksha-smith", "fengyuan-yaksha-apprentice"], ["canon-jin-yue", "feiling-fifth-elder"],
        ["canon-xue-du", "canon-jin-ling-ape"], ["minghe-box-smith", "minghe-young-gardener"],
        ["innerstar-bamboo-guardian", "innerstar-bamboo-student"], ["innerstar-fishing-head", "innerstar-fisher-daughter"]]) {
        expect(knows(a!, b!)).toBe(true); expect(knows(b!, a!)).toBe(true);
      }
      expect(state.truth.placements["canon-li-rong"]).toBe("fengyuan-lirong-hidden-cave");
      expect(knows("canon-mo-jian-li", "fengyuan-lirong-hidden-cave")).toBe(false);
      expect(state.truth.placements["feiling-broken-tongs"]).toBe("feiling-miner-brother");
      expect(quantity("craft-material", "feiling-brother-repair-stock")).toBe(2);
      for (const number of [1, 2]) expect(state.truth.placements[`feiling-jinling-sword-${number}`]).toBe("feiling-jinling-swords");
      expect(state.truth.placements["minghe-finished-seal-box"]).toBe("minghe-workshop");
      expect(quantity("high-stone", "minghe-gate-fuel")).toBe(4);
      expect(state.truth.facts["minghe-outer-gate-prepared-openings"]!.value).toEqual({ kind: "number", value: 1 });
      expect(state.truth.facts["minghe-outer-gate-condition-minghe-inspection-court"]!.description).toContain("无须启动跨界");
      expect(state.truth.facts["minghe-outer-gate-condition-minghe-entry-bank"]!.description).toContain("四块高阶灵石");
      expect(state.truth.facts["minghe-outer-gate-next-opening-preparation"]!.description).toContain("62208000");
      expect(state.truth.placements["canon-tianlei-bamboo"]).toBe("innerstar-bamboo-garden");
      expect(quantity("herb-packet", "innerstar-bamboo-treasury")).toBe(8);
      expect(quantity("low-stone", "innerstar-ship-escort-purse")).toBe(30);
      expect(quantity("copper", "innerstar-fisher-daughter")).toBe(45);
      expect(Object.keys(state.truth.entities).filter(id => id === "canon-ling-xiaofeng")).toHaveLength(1);
      expect(state.truth.entities["canon-ling-tianlei"]).toBeUndefined();
      expect(state.truth.entities["canon-yuan-yao"]).toBeUndefined();
      expect(state.truth.entities["canon-yan-li"]).toBeUndefined();
      for (const [a, b] of [["canon-suanni-king", "canon-suanni-elder"], ["canon-jin-jiao-wang", "canon-wu-dujiao"],
        ["outerstar-employer", "outerstar-jobseeker"], ["outerstar-egg-keeper", "outerstar-cunjin-keeper"]]) {
        expect(knows(a!, b!)).toBe(true); expect(knows(b!, a!)).toBe(true);
      }
      expect(quantity("top-stone", "outerstar-hidden-wood-stone")).toBe(1);
      expect(quantity("copper", "outerstar-wage-purse")).toBe(900);
      expect(quantity("low-stone", "outerstar-village-common-store")).toBe(90);
      expect(state.truth.placements["canon-thunder-peng-remains"]).toBe("outerstar-ancient-ruin");
      expect(state.truth.placements["canon-fan-sheng-fragment"]).toBe("outerstar-suanni-vault");
      expect(state.truth.facts["outerstar-ningcui-array-stock-owned-by"]!.value).toEqual({ kind: "entity", entityId: "star-palace" });
      expect(state.truth.facts["outerstar-qiyuan-array-stock-owned-by"]!.value).toEqual({ kind: "entity", entityId: "outerstar-port-coalition" });
      expect(state.truth.facts["canon-gui-xuangui-cultivation-state"]!.description).toContain("未渡化形劫");
      expect(state.truth.facts["outerstar-feng-wine-composition"]!.description).toContain("没有那次专门加入的混沌魔气");
      expect(Object.values(state.agents).some(agent => Object.values(agent.bindings).some(binding =>
        binding.canonicalEntityIds.includes("canon-thunder-peng-remains") || binding.canonicalEntityIds.includes("outerstar-hidden-wood-stone")))).toBe(false);
      const applicantView = JSON.stringify(projectAgentPerspective(state, state.agents["outerstar-jobseeker"]!));
      expect(applicantView).toContain("三日九十");
      expect(applicantView).toContain("两网每张六十");
      expect(state.truth.placements["feiling-chirong-mountains"]).toBe("fengyuan-continent");
      expect(state.truth.placements["guanghan-xuling-pill-3"]).toBe("guanghan-purple-pill-bottle");
      expect(Object.values(state.truth.entities).filter(entity => /^guanghan-xuling-pill-[1-3]$/.test(entity.id))).toHaveLength(3);
      expect(state.truth.placements["guanghan-wanjian-map"]).toBe("guanghan-seventh-chamber");
      expect(state.truth.placements["guanghan-ningcui-horse-1"]).toBe("guanghan-herb-jade-box");
      expect(quantity("guanghan-pure-top-stone", "guanghan-palace-door-stones")).toBe(36);
      expect(quantity("top-stone", "guanghan-palace-door-stones")).toBe(0);
      expect(state.truth.facts["guanghan-gourd-sword-1-craft-state"]!.description).toContain("未炼成");
      const archivistView = JSON.stringify(projectAgentPerspective(state, state.agents["guanghan-archivist"]!));
      expect(archivistView).not.toContain("第三层停滞");
      expect(knows("guanghan-archivist", "guanghan-wanjian-map")).toBe(false);
      expect(state.truth.placements["canon-xutian-ding"]).toBe("void-hanli-platform");
      expect(state.truth.placements["canon-wolf-head-jade-ruyi"]).toBe("canon-xutian-ding");
      expect(state.truth.placements["canon-xueling-soul"]).toBe("canon-wolf-head-jade-ruyi");
      expect(state.truth.placements["canon-xuangu-old-bones"]).toBe("void-xuangu-tomb");
      expect(state.truth.entities["canon-qu-hun"]).toBeUndefined();
      expect(state.truth.entities["canon-wu-chou"]).toBeUndefined();
      for (const [a, b] of [["void-island-steward", "void-boat-owner"], ["void-map-restorer", "void-map-customer"]]) {
        expect(knows(a!, b!)).toBe(true); expect(knows(b!, a!)).toBe(true);
      }
      expect(knows("canon-ji-yin", "canon-xuangu-void-map")).toBe(false);
      expect(knows("void-tomb-warden", "canon-xuangu-void-map")).toBe(false);
      expect(state.truth.facts["void-natural-cycle"]!.value).toEqual({ kind: "text", value: "natural-closed-window" });
      expect(state.truth.placements["associated-yinming"]).toBe("canon-human-luohou");
      expect(state.truth.facts["associated-yinming-daylight"]!.value).toEqual({ kind: "text", value: "constant-cloud-light" });
      expect(state.truth.entities["canon-feng-tianji"]).toBeUndefined();
      expect(quantity("yin-crystal", "yinming-crystals-main")).toBe(8);
      expect(quantity("yin-charge", "yinming-protector-main")).toBe(240);
      expect(quantity("grain", "yinming-seed-bin")).toBe(20);
      expect(knows("yinming-array", "yinming-deputy")).toBe(true);
      expect(knows("yinming-deputy", "yinming-array")).toBe(true);
      expect(knows("yinming-grain", "canon-human-luohou")).toBe(false);
      expect(state.truth.placements["yinming-trade-letter"]).toBe("yinming-ridge-runner");
      const saintView = JSON.stringify(projectAgentPerspective(state, state.agents["canon-ling-xiaofeng"]!));
      expect(saintView).not.toContain("最后关口必须具备五行灵根");
      const daughterView = JSON.stringify(projectAgentPerspective(state, state.agents["innerstar-fisher-daughter"]!));
      expect(daughterView).not.toContain("木水火灵根");
      expect(daughterView).toContain("没有经过灵根检测");
      const player = created.participants[0]!.agentId;
      expect(knows("canon-qing-yuan-zi", player)).toBe(false);
      expect(knows("canon-ling-xiaofeng", player)).toBe(false);
      expect(replaySimulationState(state)).toEqual(state);
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps the unique magnetic mountain and derives its exceptional month from the actual clock", async () => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-magnetic-cycle-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(archive(), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId: "spirit-merchant", displayName: "舟客", appearance: "", motivation: "做生意。" } });
      const state = database.readInstance(created.summary.id).document.state;
      expect(state.truth.placements["canon-yuanci-mountain"]).toBe("innerstar-magnetic-cavern");
      expect(state.truth.facts["innerstar-yuanci-cycle"]!.value).toEqual({ kind: "text", value: "magnetism-active" });
      const advance = (seconds: number) => applyTransitionProposal(state, { baseRevision: state.revision, outcomes: [], mechanicInvocations: [], observations: [], decisionRequests: [], events: [],
        operations: [{ kind: "advance_time", seconds, causes: [{ kind: "mechanic", id: "calendar-verification" }], assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }] }] });
      const window = advance(1576800000), closed = advance(1576800000 + 2592000);
      expect(window.truth.facts["innerstar-yuanci-cycle"]!.value).toEqual({ kind: "text", value: "magnetism-absent" });
      expect(closed.truth.facts["innerstar-yuanci-cycle"]!.value).toEqual({ kind: "text", value: "magnetism-active" });
      expect(window.truth.placements["canon-ling-xiaofeng"]).toBe(state.truth.placements["canon-ling-xiaofeng"]);
      expect(Object.keys(window.truth.entities)).toEqual(Object.keys(state.truth.entities));
      const forestNight = advance(151200 + 115200);
      expect(forestNight.truth.facts["guanghan-dark-forest-daylight"]!.value).toEqual({ kind: "text", value: "night" });
      expect(forestNight.truth.facts["spirit-realm-daylight"]!.value).toEqual({ kind: "text", value: "day" });
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
