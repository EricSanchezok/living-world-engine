import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { directTestProvider, nativeAnswer } from "../../src/engine/testing/direct-provider";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { quantityId } from "../../src/engine/runtime/runtime-id";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

describe("Fanren opening sample import and entry", () => {
  it.each(["han-li", "herbal-apprentice", "merchant-heir", "escort-apprentice", "clan-junior", "foundation-independent", "core-clan-elder", "spirit-merchant", "spirit-array-master"])("persists %s with authored identity, property and knowledge", async originId => {
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question, "none")])));
    await f.registry.capture();
    const archive = new AdmZip(); archive.addLocalFolder(path.resolve("worlds/fanren/samples/opening/world"));
    const root = mkdtempSync(path.join(tmpdir(), "fanren-entry-"));
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const imported = database.importWorld(archive.toBuffer(), f.catalog);
      expect(imported.id).toBe("fanren-opening-sample");
      const host = new WorldHost({ repository: database, store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: imported.id, start: { kind: "origin", originId,
        displayName: originId === "han-li" ? "韩立" : "测试玩家", appearance: "", motivation: "" } });
      const state = database.readInstance(created.summary.id).document.state;
      const player = created.participants[0]!.agentId;
      const quantity = (owner: string, kind: string) => state.truth.quantities[quantityId(state.worldHash, kind, owner)]?.amount ?? 0;
      expect(Object.values(state.truth.entities).filter(entity => entity.id === "canon-han-li")).toHaveLength(1);
      expect(state.truth.entities).not.toHaveProperty("small-green-bottle");
      expect(replaySimulationState(state)).toEqual(state);
      if (originId === "han-li") {
        expect(player).toBe("canon-han-li"); expect(state.admissions).toHaveLength(0);
        expect(state.truth.placements[player]).toBe("han-home");
        expect(state.agents[player]!.bindings["familiar-path"]!.canonicalEntityIds).toEqual(["village-path"]);
        expect(JSON.stringify(projectAgentPerspective(state, state.agents[player]!))).not.toContain("四属性伪灵根");
        expect(quantity(player, "grain")).toBe(0); expect(quantity("han-household-pantry", "grain")).toBe(12);
      } else if (originId === "herbal-apprentice") {
        expect(state.agents[player]!.bindings.master!.canonicalEntityIds).toEqual(["herbal-master"]);
        expect(state.agents["herbal-master"]!.bindings.student!.canonicalEntityIds).toEqual([player]);
        expect(state.agents["herbal-mother"]!.bindings.child!.canonicalEntityIds).toEqual([player]);
        expect(state.truth.placements["herbal-consignment"]).toBe(player);
        expect(state.truth.facts["herbal-consignment-owned-by-herbal-master"]!.value).toEqual({ kind: "entity", entityId: "herbal-master" });
        expect(quantity("herbal-consignment", "herb-packet")).toBe(12); expect(quantity(player, "copper")).toBe(36);
        expect(JSON.stringify(projectAgentPerspective(state, state.agents[player]!))).not.toContain("金木水土四属性");
      } else if (originId === "spirit-merchant") {
        expect(state.agents["spirit-manager"]!.bindings.proprietor!.canonicalEntityIds).toEqual([player]);
        expect(quantity(player, "low-stone")).toBe(8000); expect(quantity("spirit-business-funds", "low-stone")).toBe(30000);
        expect(quantity("spirit-stock", "material-crate")).toBe(17); expect(quantity("spirit-missing-cargo", "material-crate")).toBe(3);
        expect(state.truth.placements["spirit-missing-cargo"]).toBe("spirit-wharf");
        expect(Object.values(state.truth.meters).find(meter => meter.entityId === player && meter.definitionId === "mana")!.current).toBe(1200);
        const perspective = JSON.stringify(projectAgentPerspective(state, state.agents[player]!));
        expect(perspective).toContain("御物"); expect(perspective).not.toContain("换车时留置");
        expect(state.truth.facts["spirit-order-one-amount"]!.value).toEqual({ kind: "number", value: 8 });
        expect(state.truth.facts["spirit-order-two-amount"]!.value).toEqual({ kind: "number", value: 12 });
      } else {
        const perspective = JSON.stringify(projectAgentPerspective(state, state.agents[player]!));
        const existingContact = (id: string, local: string) => {
          expect(state.agents[id]!.bindings[local]!.canonicalEntityIds).toEqual([player]);
          expect(Object.values(state.agents[player]!.bindings).some(binding => binding.canonicalEntityIds.includes(id))).toBe(true);
        };
        const level = (value: number, mana: number) => {
          expect(Object.values(state.truth.ratings).find(rating => rating.entityId === player && rating.definitionId === "cultivation")!.value).toBe(value);
          expect(Object.values(state.truth.meters).find(meter => meter.entityId === player && meter.definitionId === "mana")!.current).toBe(mana);
        };
        if (originId === "merchant-heir") {
          existingContact("lin-father", "child"); existingContact("lin-manager", "heir");
          expect(quantity(player, "silver")).toBe(40); expect(quantity(player, "copper")).toBe(600);
          expect(quantity("lin-funds", "silver")).toBe(1200); expect(quantity("lin-herbs", "herb-crate")).toBe(60);
          expect(state.truth.facts["lin-herbs-owner"]!.value).toEqual({ kind: "entity", entityId: "lin-firm" });
          expect(perspective).not.toContain("木水火属性灵根"); expect(perspective).not.toContain("实际是炼气六层");
          level(0, 0);
        } else if (originId === "escort-apprentice") {
          existingContact("escort-master", "student"); existingContact("escort-cultivator", "benefactor");
          expect(quantity(player, "silver")).toBe(3); level(0, 0);
          expect(state.truth.facts["escort-favor-debtor"]!.value).toEqual({ kind: "entity", entityId: player });
          expect(state.truth.facts["escort-cargo-owner"]!.value).toEqual({ kind: "entity", entityId: "escort-client" });
          expect(perspective).toContain("无灵根"); expect(perspective).not.toContain("十二件普通精钢器坯");
        } else if (originId === "clan-junior") {
          existingContact("shen-mother", "child"); existingContact("shen-peer", "peer");
          expect(quantity(player, "low-stone")).toBe(18); level(1, 30);
          expect(Object.keys(state.truth.entities).filter(id => /^shen-old-\d+$/u.test(id))).toHaveLength(9);
          expect(state.truth.facts["shen-old-1-owner"]!.value).toEqual({ kind: "entity", entityId: "shen-clan" });
          expect(perspective).not.toContain("内承压环完好");
        } else if (originId === "foundation-independent") {
          existingContact("pond-qinghe", "mentor"); existingContact("pond-zhaosong", "mentor");
          expect(quantity(player, "low-stone")).toBe(260); level(2, 200);
          expect(quantity("pond-household", "maintenance-material")).toBe(8);
          expect(state.truth.facts["pond-array-wear"]!.value).toEqual({ kind: "number", value: 3 });
          expect(state.truth.placements["pond-flight"]).toBe(player);
        } else if (originId === "core-clan-elder") {
          existingContact("xu-manager", "elder"); existingContact("xu-cousin", "elder");
          expect(quantity(player, "low-stone")).toBe(2200); expect(quantity(player, "mid-stone")).toBe(12); level(3, 500);
          expect(quantity("xu-funds", "low-stone")).toBe(9000); expect(quantity("xu-raw-material", "craft-material")).toBe(120);
          expect(state.truth.facts["xu-workshop-owner"]!.value).toEqual({ kind: "entity", entityId: "xu-clan" });
        } else {
          existingContact("array-friend", "friend"); existingContact("array-assistant", "mentor");
          expect(quantity(player, "low-stone")).toBe(20000); expect(quantity(player, "mid-stone")).toBe(220); expect(quantity(player, "high-stone")).toBe(4);
          level(6, 1800);
          expect(state.truth.placements["array-fragment"]).toBe("array-friend");
          expect(Object.values(state.truth.facts).filter(fact => fact.subjectId === "array-fragment" && fact.predicate === "owned-by")).toHaveLength(0);
          expect(state.truth.facts["array-fragment-owner"]!.predicate).toBe("ownership-disputed");
          expect(state.truth.placements["array-manual"]).toBe(player);
          expect(perspective).not.toContain("外环第四接点断裂"); expect(perspective).not.toContain("只授权借用测绘");
        }
      }
      expect(f.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
