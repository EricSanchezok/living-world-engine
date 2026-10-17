import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { quantityId } from "../../src/engine/runtime/runtime-id";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { directTestProvider, nativeAnswer } from "../../src/engine/testing/direct-provider";
import { parseWorldTemplate } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

const routes = [
  ["herbal-apprentice", "herbal-north-slope", "herbal-general-shop", "herbal-receiving-stall"],
  ["merchant-heir", "lin-old-client-shop", "lin-buyer-apothecary", "lin-stockroom", "lin-account-room"],
  ["escort-apprentice", "escort-destination"],
  ["clan-junior", "shen-workbench"],
  ["foundation-independent", "pond-grove"],
  ["core-clan-elder", "xu-ruin-entrance", "xu-workshop"],
  ["spirit-merchant", "spirit-concession-site", "spirit-wharf"],
  ["spirit-array-master", "array-exchange-shop", "array-workroom"],
] as const;

function archiveFromAuthoredModule(): Buffer {
  const bundle = JSON.parse(readFileSync(path.resolve("worlds/fanren/authoring/modules/opening-sample.json"), "utf8"));
  const template = parseWorldTemplate(bundle.template);
  const archive = new AdmZip();
  const files: Array<[string, unknown]> = [
    ["script.yaml", template.manifest], ["laws.yaml", template.laws],
    ["mechanics.yaml", template.mechanics], ["participation.yaml", template.participation],
    ...template.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as [string, unknown]),
  ];
  for (const [file, contents] of files) archive.addFile(file, Buffer.from(stringify(contents)));
  return archive.toBuffer();
}

describe("Fanren authored livelihood continuations", () => {
  it.each(routes)("imports %s with reachable work and bounded private knowledge", async (originId, ...destinations) => {
    const fixture = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions)
      .map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await fixture.registry.capture();
    const directory = mkdtempSync(path.join(tmpdir(), "fanren-livelihoods-"));
    const database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(archiveFromAuthoredModule(), fixture.catalog);
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: fixture.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: {
        kind: "origin", originId, displayName: "行路人", appearance: "", motivation: "按自己的判断处理眼前的人与事。",
      } });
      const state = database.readInstance(created.summary.id).document.state;
      const actor = created.participants[0]!.agentId;
      const known = JSON.stringify(projectAgentPerspective(state, state.agents[actor]!));
      expect(known).toContain("开篇时此地已入夜");
      expect(Object.values(state.truth.facts).some(fact => fact.predicate === "local-time")).toBe(false);
      expect(state.truth.facts["human-realm-daylight"]?.value).toEqual({ kind: "text", value: "night" });
      expect(state.truth.facts["spirit-realm-daylight"]?.value).toEqual({ kind: "text", value: "night" });
      const quantity = (owner: string, kind: string) => state.truth.quantities[quantityId(state.worldHash, kind, owner)]?.amount ?? 0;
      const reached = new Set([state.truth.placements[actor]!]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const fact of Object.values(state.truth.facts)) {
          if (fact.predicate === "route-to" && fact.value.kind === "entity" && reached.has(fact.subjectId) && !reached.has(fact.value.entityId)) {
            reached.add(fact.value.entityId); grew = true;
          }
        }
      }
      for (const destination of destinations) expect(reached, `unreachable authored destination ${destination}`).toContain(destination);
      for (const agent of Object.values(state.agents)) {
        if (!agent.id.startsWith("canon-") && !agent.id.startsWith("han-") && agent.id !== "old-zhang" && agent.id !== actor) {
          expect(Object.values(agent.belief.claims).some(claim => claim.predicate === "learned-skill"), `${agent.id} lacks learned methods`).toBe(true);
        }
      }
      if (originId === "herbal-apprentice") {
        expect(quantity("herbal-buyer", "copper")).toBeGreaterThanOrEqual(96);
        expect(quantity("herbal-shopkeeper", "salt-bag")).toBeGreaterThan(0);
        expect(quantity("herbal-shopkeeper", "lamp-oil")).toBeGreaterThan(0);
        expect(state.truth.placements["herbal-marked-stem"]).toBe("herbal-consignment");
        expect(known).not.toContain("裂缝蓄水与成熟度使");
      } else if (originId === "merchant-heir") {
        expect(quantity("lin-buyer", "silver")).toBeGreaterThanOrEqual(1200);
        expect(state.truth.placements["lin-herbs"]).toBe("lin-stockroom");
        expect(state.truth.placements["lin-stock-ledger"]).toBe("lin-account-room");
        expect(state.truth.placements["lin-funds"]).toBe("lin-account-room");
        expect(quantity("lin-herbs", "herb-crate")).toBe(60);
        for (const id of ["lin-father", "lin-manager", "lin-helper"]) {
          const agent = state.agents[id]!;
          for (const destination of ["lin-store", "lin-stockroom", "lin-account-room", "lin-herbs", "lin-stock-ledger", "lin-hand-lamp"]) {
            expect(Object.values(agent.bindings).some(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === destination), `${id} does not know ${destination}`).toBe(true);
          }
          expect(Object.values(agent.belief.evidence).some(evidence => evidence.description.includes("亲自走过"))).toBe(true);
          expect(JSON.stringify(projectAgentPerspective(state, agent))).not.toContain("当日日落前记入");
        }
        expect(quantity("lin-old-client", "silver")).toBeGreaterThanOrEqual(600);
        expect(state.truth.facts["lin-old-order-customer"]?.value).toEqual({ kind: "entity", entityId: "lin-old-client" });
        expect(state.truth.facts["lin-helper-wage-remaining-amount"]?.value).toEqual({ kind: "number", value: 2 });
        expect(known).not.toContain("石桥辅药房需要普通药材作辅料");
      } else if (originId === "escort-apprentice") {
        expect(state.truth.placements["escort-watcher"]).toBe("escort-stone-bridge");
        expect(state.truth.facts["escort-fee-balance-remaining-amount"]?.value).toEqual({ kind: "number", value: 15 });
        expect(known).not.toContain("目的是抢先谈价");
      } else if (originId === "clan-junior") {
        expect(quantity("shen-clan-cash", "low-stone")).toBe(12);
        expect(quantity("shen-wire-stock", "joining-wire")).toBe(6);
        expect(state.truth.facts["shen-maintenance-debt-remaining-amount"]?.value).toEqual({ kind: "number", value: 18 });
        expect(known).not.toContain("内承压环完好");
      } else if (originId === "foundation-independent") {
        expect(quantity("pond-wild-herbs", "herb-packet")).toBe(12);
        expect(Object.values(state.agents["pond-wenshen"]!.bindings).some(binding => binding.canonicalEntityIds.includes("pond-grove"))).toBe(true);
        expect(Object.values(state.agents[actor]!.bindings).some(binding => binding.canonicalEntityIds.includes("pond-grove"))).toBe(false);
      } else if (originId === "core-clan-elder") {
        expect(quantity("xu-finished-stock", "prepared-material")).toBe(0);
        expect(quantity("xu-raw-material", "craft-material")).toBe(120);
        expect(quantity("xu-kiln-remnant", "craft-material")).toBe(2);
        expect(known).not.toContain("炉芯已经碎裂");
      } else if (originId === "spirit-merchant") {
        expect(state.truth.facts["spirit-concession-expiry-world-second"]?.value).toEqual({ kind: "number", value: 10368000 });
        expect(state.truth.facts["spirit-manager-wage-due-world-second"]?.value).toEqual({ kind: "number", value: 1036800 });
        expect(quantity("spirit-stock", "material-crate") + quantity("spirit-missing-cargo", "material-crate")).toBe(20);
        expect(state.truth.placements["spirit-carrier-receipt"]).toBe("spirit-carrier");
        expect(state.truth.placements["spirit-loading-record"]).toBe("spirit-supplier");
        expect(quantity("spirit-surface-samples", "mineral-sample")).toBe(9);
        expect(known).not.toContain("三箱在换车时暂置货场第三排");
      } else {
        expect(state.truth.placements["array-exchange-receipt"]).toBe("array-friend");
        expect(state.truth.placements["array-borrowing-copy"]).toBe("array-broker");
        expect(quantity("array-broker", "low-stone")).toBeGreaterThanOrEqual(200);
        expect(quantity("array-repair-stock", "array-thread")).toBe(3);
        expect(quantity("array-repair-stock", "sealing-sand")).toBe(2);
        expect(known).not.toContain("梁阙误将此物当作可代售寄件");
      }
      expect(replaySimulationState(state)).toEqual(state);
      expect(fixture.transport).not.toHaveBeenCalled();
    } finally {
      database.close(); rmSync(directory, { recursive: true, force: true });
    }
  });
});
