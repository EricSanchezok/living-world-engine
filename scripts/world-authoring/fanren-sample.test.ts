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
  it.each(["han-li", "herbal-apprentice", "spirit-merchant"])("persists %s with authored identity, property and knowledge", async originId => {
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
      } else {
        expect(state.agents["spirit-manager"]!.bindings.proprietor!.canonicalEntityIds).toEqual([player]);
        expect(quantity(player, "low-stone")).toBe(8000); expect(quantity("spirit-business-funds", "low-stone")).toBe(30000);
        expect(quantity("spirit-stock", "material-crate")).toBe(17); expect(quantity("spirit-missing-cargo", "material-crate")).toBe(3);
        expect(state.truth.placements["spirit-missing-cargo"]).toBe("spirit-wharf");
        expect(Object.values(state.truth.meters).find(meter => meter.entityId === player && meter.definitionId === "mana")!.current).toBe(1200);
        const perspective = JSON.stringify(projectAgentPerspective(state, state.agents[player]!));
        expect(perspective).toContain("御物"); expect(perspective).not.toContain("换车时留置");
        expect(state.truth.facts["spirit-order-one-amount"]!.value).toEqual({ kind: "number", value: 8 });
        expect(state.truth.facts["spirit-order-two-amount"]!.value).toEqual({ kind: "number", value: 12 });
      }
      expect(f.transport).not.toHaveBeenCalled();
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
