import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directCreationContext, directTestProvider, type DirectTestWire } from "../../engine/testing/direct-provider";
import { finishMemory, memorySource } from "../../engine/cognition/memory";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

async function fixture(arrival: (wire: DirectTestWire) => unknown | Promise<unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "takeover-arrival-"));
  const provider = directTestProvider(() => { throw new Error("Takeover must not execute world actions"); }, undefined, { arrival });
  await provider.registry.capture();
  const script = path.join(root, "world");
  cpSync(path.resolve("test/fixtures/open-world-script"), script, { recursive: true });
  const keeperFile = path.join(script, "entities/keeper.yaml"), keeper = parse(readFileSync(keeperFile, "utf8"));
  keeper.agent.belief.evidence = Array.from({ length: 20 }, (_, index) => ({ id: `arrival-memory-${String(index).padStart(2, "0")}`,
    step: 0, sourceId: null, kind: "testimony", description: index === 0 ? "答应在天亮前把借来的铜灯还给同伴。"
      : `普通往事 ${index}。${"门前有人来往，谈论天气。".repeat(30)}` }));
  keeper.facts.push({ id: "hidden-takeover-fact", predicate: "unrevealed-plan", value: { kind: "text", value: "TRUTH-ONLY-SECRET" },
    description: "Only the traveler knows this plan.", access: { kind: "agents", agentIds: ["player"] } });
  writeFileSync(keeperFile, stringify(keeper));
  const playerFile = path.join(script, "entities/player.yaml"), player = parse(readFileSync(playerFile, "utf8"));
  player.agent.belief.evidence.push({ id: "other-private-memory", step: 0, sourceId: null, kind: "assumption", description: "OTHER-AGENT-SECRET" });
  writeFileSync(playerFile, stringify(player));
  const world = loadWorldScript(script, { seed: 9, modelCatalog: provider.catalog });
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const makeHost = () => new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: provider.gateway });
  const host = makeHost(), id = (await host.createInstance({ worldId: world.id, start: { kind: "observer" } })).summary.id;
  return { provider, database, host, id, makeHost, close: () => { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("direct Agent takeover arrival", () => {
  it("writes one saved opening from private retained memory without advancing the world or regenerating on retry", async () => {
    let request: Record<string, unknown> | undefined;
    const f = await fixture(wire => { request = directCreationContext(wire); return { title: "还灯之前", scene: "你仍记得答应同伴的事：天亮前归还铜灯。" }; });
    try {
      expect(f.provider.transport).not.toHaveBeenCalled();
      const stored = f.database.readInstance(f.id), next = structuredClone(stored.document);
      const source = memorySource(next.state, "keeper")!;
      next.agentMemories.keeper = { checkpoint: finishMemory(source, {
        summary: "守门期间的普通往来已归纳，仍记着归还铜灯的承诺。", retainEvidenceIds: ["arrival-memory-00"], retainClaimIds: [],
      }, null), attempt: null };
      f.database.compareAndSwapInstance(f.id, stored.generation, next);
      const before = f.database.readInstance(f.id).document.state;
      const view = await f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } });
      expect(f.provider.transport).toHaveBeenCalledTimes(1);
      const saved = f.database.readInstance(f.id).document, participant = saved.participants[view.conversation!.participantId]!;
      expect(saved.state).toEqual(before);
      expect(participant.arrival).toMatchObject({ generated: true, revision: 0, step: 0, title: "还灯之前", scene: "你仍记得答应同伴的事：天亮前归还铜灯。" });
      const perspective = (request!.state as { perspective: Record<string, unknown> }).perspective;
      expect(perspective).toMatchObject({ agentId: "keeper", memory: { version: 1, summary: next.agentMemories.keeper.checkpoint!.summary } });
      expect(perspective).not.toHaveProperty("reads");
      expect(perspective).not.toHaveProperty("entities");
      expect(perspective).not.toHaveProperty("bindings");
      const encoded = JSON.stringify(request);
      expect(encoded).toContain("天亮前把借来的铜灯还给同伴");
      expect(encoded).toContain("普通往事 19");
      expect(encoded).not.toContain("普通往事 3");
      expect(encoded).not.toContain("TRUTH-ONLY-SECRET");
      expect(encoded).not.toContain("OTHER-AGENT-SECRET");
      expect(encoded).not.toContain("canonicalEntityIds");
      const arrivalExecution = f.database.executions({ instanceId: f.id }).find(item => item.manifest.kind === "engine-operation" && item.manifest.id === "arrival-generator")!;
      expect(arrivalExecution.status).toBe("succeeded");
      expect(f.database.executionEvents(arrivalExecution.id).some(event => event.event === "memory.read")).toBe(true);
      expect(await f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } })).toEqual(view);
      await expect(f.host.transferControl(f.id, { expectedRevision: 1, target: { kind: "agent", agentId: "player" } })).rejects.toThrow("world revision changed");
      expect(f.makeHost().instance(f.id).conversation).toEqual(view.conversation);
      expect(f.provider.transport).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it("persists a neutral fallback after a failed creation call without losing control or retrying on reads", async () => {
    const f = await fixture(() => new Response("unavailable", { status: 503 }));
    try {
      const before = f.database.readInstance(f.id).document.state;
      const view = await f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } });
      const saved = f.database.readInstance(f.id).document;
      expect(saved.state).toEqual(before);
      expect(saved.policyBindings.keeper).toMatchObject({ kind: "external", participantId: view.conversation!.participantId });
      expect(saved.participants[view.conversation!.participantId]!.arrival).toMatchObject({ generated: false, scene: "你把注意力放回 守门人 的此刻。" });
      expect(f.database.executions({ instanceId: f.id }).filter(item => item.manifest.kind === "engine-operation" && item.manifest.id === "arrival-generator"))
        .toEqual([expect.objectContaining({ status: "failed" })]);
      f.host.instance(f.id);
      expect(f.makeHost().instance(f.id).conversation).toEqual(view.conversation);
      await f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } });
      expect(f.provider.transport).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });

  it("does not overwrite a concurrent persisted update when the arrival request loses its generation CAS", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(async () => { entered(); await gate; return { title: "此刻", scene: "你记起自己守门的职责。" }; });
    try {
      const taking = f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } });
      await started;
      const stored = f.database.readInstance(f.id), next = structuredClone(stored.document);
      next.updatedAt = "2030-01-01T00:00:00.000Z";
      f.database.compareAndSwapInstance(f.id, stored.generation, next);
      const rejected = expect(taking).rejects.toThrow();
      release(); await rejected;
      const saved = f.database.readInstance(f.id).document;
      expect(saved).toEqual(next);
      expect(saved.participants).toEqual({});
      expect(saved.policyBindings.keeper).toMatchObject({ kind: "model" });
      expect(f.provider.transport).toHaveBeenCalledTimes(1);
    } finally { release(); f.close(); }
  });
});
