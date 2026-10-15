import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, directCreationContext, nativeAnswer, type DirectTestWire } from "../../engine/testing/direct-provider";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

async function harness(suggest: (context: ReturnType<typeof directCreationContext>) => unknown | Promise<unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-suggestions-"));
  const contexts: Record<string, unknown>[] = [];
  const provider = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
    const values: Record<string, string> = { operation: "observe", target: "self", timing: "default" };
    const choice = values[id] ?? (id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded"
      : id.includes("request_progress") ? "complete" : id.includes("visible") || id.includes("entity") ? "visible"
      : id.includes("status") || id.includes("fact") ? "unchanged" : "none");
    return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
  })), () => ({ paragraphs: ["你清点过随身物品，石门就在眼前。"] }), {
    suggestions: async (wire: DirectTestWire) => {
      const context = directCreationContext(wire); contexts.push(context);
      return suggest(context);
    },
  });
  await provider.registry.capture();
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: provider.catalog });
  const repository = new MemoryWorldRepository({ [world.id]: world });
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: provider.gateway });
  const host = makeHost();
  const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: "courtyard-wanderer",
    displayName: "测试旅人", appearance: "旅行装束", motivation: "找到石门后的道路" } });
  const id = created.summary.id, participantId = created.conversation!.participantId;
  const stored = () => database.readInstance(id).document;
  const act = async (submissionId: string, text: string) => {
    await host.submitAction(id, participantId, { expectedRevision: stored().state.revision, submissionId, text });
    await expect.poll(() => host.instance(id).conversation?.turns.at(-1)?.status, { timeout: 10_000 }).toBe("committed");
    await host.drainNarratives(id);
  };
  return { host, makeHost, database, provider, contexts, created, id, participantId, stored, act,
    close: async () => { await host.drainNarratives(id); await host.drainSuggestions(id); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("contextual suggestions through WorldHost and the model transport", () => {
  it("publishes one creation batch per settled context, deduplicates, and reuses it through refresh and restart", async () => {
    const h = await harness(context => ({ items: context.latestRequest
      ? [`继续${context.latestRequest}`, `  继续${context.latestRequest}！`, String(context.latestRequest)]
      : ["询问守门人道路", "检查石门痕迹", "整理探索打算"] }));
    try {
      const openingState = structuredClone(h.stored().state);
      await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions?.items).toHaveLength(3);
      expect(h.contexts).toHaveLength(1);
      expect(h.stored().state).toEqual(openingState);
      expect(h.created.conversation?.turns[0]?.response).not.toHaveProperty("possibleNextActions");
      const batches = [h.host.instance(h.id).conversation!.suggestions!.sourceId];
      for (const text of ["看看身上的物品", "查看刚刚清点的物资"]) {
        await h.act(`action-${batches.length}`, text);
        const state = structuredClone(h.stored().state), intents = structuredClone(h.stored().participantIntents);
        await h.host.drainSuggestions(h.id);
        const batch = h.host.instance(h.id).conversation!.suggestions!;
        expect(batch.items).toEqual([`继续${text}`]);
        expect(batches).not.toContain(batch.sourceId); batches.push(batch.sourceId);
        expect(h.stored().state).toEqual(state); expect(h.stored().participantIntents).toEqual(intents);
      }
      expect(h.contexts).toHaveLength(3);
      expect(h.contexts[1]!.discourse).toMatchObject({ exchanges: [expect.objectContaining({ paragraphs: expect.any(Array) })] });
      const current = h.host.instance(h.id).conversation!.suggestions;
      for (let i = 0; i < 5; i++) expect(h.host.instance(h.id).conversation!.suggestions).toEqual(current);
      const recovered = h.makeHost();
      expect(recovered.instance(h.id).conversation!.suggestions).toEqual(current);
      await recovered.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(3);
      const records = h.database.executions({ instanceId: h.id }).filter(execution => execution.manifest.id === "action-suggestions");
      expect(records).toHaveLength(3);
      for (const record of records) {
        expect(record.status).toBe("succeeded");
        const events = h.database.executionEvents(record.id);
        expect(events.some(event => event.event === "suggestions.generated")).toBe(true);
        expect(JSON.stringify(events)).toContain("creation-deepseek");
      }
    } finally { await h.close(); }
  });

  it("discards an opening result that arrives after a new action and never blocks that action", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(context => context.latestRequest ? { items: ["询问下一段道路"] } : gate);
    try {
      await expect.poll(() => h.contexts.length).toBe(1);
      const oldSource = h.stored().participants[h.participantId]!.suggestions!.sourceId;
      await h.act("while-suggesting", "清点行装");
      expect(h.host.instance(h.id).conversation?.suggestions).toBeNull();
      release({ items: ["过时的开场建议"] });
      await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ items: ["询问下一段道路"] });
      expect(h.host.instance(h.id).conversation?.suggestions?.sourceId).not.toBe(oldSource);
      expect(h.contexts).toHaveLength(2);
    } finally { release({ items: [] }); await h.close(); }
  });

  it("isolates control ownership and refuses a released participant's late result", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(context => (context.perspective as { self: { name: string } }).self.name === "测试旅人"
      ? gate : { items: ["留意石门前的访客"] });
    try {
      await expect.poll(() => h.contexts.length).toBe(1);
      const oldContext = JSON.stringify(h.contexts[0]);
      expect(oldContext).not.toContain("canonicalEntityIds");
      expect(oldContext).not.toContain('"bindings"');
      expect(oldContext).not.toContain("答应同伴值守到天亮");
      expect(oldContext).not.toContain("尚未信任这名旅人");
      const next = await h.host.transferControl(h.id, { expectedRevision: h.stored().state.revision, target: { kind: "agent", agentId: "keeper" } });
      release({ items: ["原角色的过时建议"] });
      await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.participantId).toBe(next.conversation!.participantId);
      expect(h.host.instance(h.id).conversation?.suggestions?.items).toEqual(["留意石门前的访客"]);
      expect(h.stored().participants[h.participantId]!.suggestions).toMatchObject({ status: "invalidated", items: [] });
      expect((h.contexts[1]!.perspective as { self: { name: string } }).self.name).toBe("守门人");
      expect(JSON.stringify(h.contexts[1])).toContain("答应同伴值守到天亮");
      expect(JSON.stringify(h.contexts[1])).not.toContain("找到石门后的道路");
    } finally { release({ items: [] }); await h.close(); }
  });

  it("keeps optional generation failure out of world state and does not retry on reads or restart", async () => {
    const h = await harness(() => { throw new Error("suggestion transport unavailable"); });
    try {
      const state = structuredClone(h.stored().state);
      await h.host.drainSuggestions(h.id);
      expect(h.stored().participants[h.participantId]!.suggestions).toMatchObject({ status: "failed", items: [] });
      expect(h.stored().state).toEqual(state);
      expect(h.host.instance(h.id).servicePause).toBeUndefined();
      for (let i = 0; i < 3; i++) expect(h.host.instance(h.id).conversation?.suggestions).toBeNull();
      const restarted = h.makeHost(); await restarted.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(1);
      expect(h.database.executions({ instanceId: h.id }).filter(execution => execution.manifest.id === "action-suggestions")).toMatchObject([{ status: "failed" }]);
    } finally { await h.close(); }
  });

  it.each(["queued", "generating"] as const)("recovers an interrupted %s record without starting another call", async status => {
    const h = await harness(() => ({ items: ["观察石门"] }));
    try {
      await h.host.drainSuggestions(h.id);
      const stored = h.database.readInstance(h.id);
      stored.document.participants[h.participantId]!.suggestions = {
        ...stored.document.participants[h.participantId]!.suggestions!, status, items: [], executionId: null,
      };
      h.database.compareAndSwapInstance(h.id, stored.generation, stored.document);
      const restarted = h.makeHost(); await restarted.drainSuggestions(h.id);
      expect(h.stored().participants[h.participantId]!.suggestions?.status).toBe("failed");
      expect(restarted.instance(h.id).conversation?.suggestions).toBeNull();
      expect(h.contexts).toHaveLength(1);
    } finally { await h.close(); }
  });
});
