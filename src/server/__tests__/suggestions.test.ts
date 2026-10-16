import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, directCreationContext, nativeAnswer, type DirectTestWire } from "../../engine/testing/direct-provider";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

async function harness(suggest: (context: ReturnType<typeof directCreationContext>) => unknown | Promise<unknown>, blackmarsh = false) {
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
  const world = loadWorldScript(path.resolve(blackmarsh ? "worlds/blackmarsh/world" : "test/fixtures/open-world-script"), { seed: 1, modelCatalog: provider.catalog });
  const repository = new MemoryWorldRepository({ [world.id]: world });
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: provider.gateway });
  const host = makeHost();
  const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: blackmarsh ? "harbor-wayfarer" : "courtyard-wanderer",
    displayName: "测试旅人", appearance: "旅行装束", motivation: "找到石门后的道路" } });
  const id = created.summary.id, participantId = created.conversation!.participantId;
  const stored = () => database.readInstance(id).document;
  const act = async (submissionId: string, text: string) => {
    await host.submitAction(id, participantId, { expectedRevision: stored().state.revision, submissionId, text });
    await expect.poll(() => host.instance(id).conversation?.turns.at(-1)?.status, { timeout: 10_000 }).toBe("committed");
    await host.drainNarratives(id);
  };
  let requestSequence = 0;
  const request = async () => {
    const source = host.instance(id).conversation!.suggestions!;
    return host.requestSuggestions(id, host.instance(id).conversation!.participantId, {
      sourceId: source.sourceId, requestId: `suggest-${++requestSequence}`, expectedRequestId: source.requestId,
    });
  };
  return { host, makeHost, database, provider, contexts, created, id, participantId, stored, act, request,
    close: async () => { await host.drainNarratives(id); await host.drainSuggestions(id); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("on-demand suggestions through WorldHost and the model transport", () => {
  it("does no automatic inference on entry, turns, reads or restart and preserves the world", async () => {
    const h = await harness(context => ({ items: context.latestRequest ? ["看看石门上的痕迹"] : ["询问守门人道路"] }));
    try {
      await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(0);
      expect(h.created.conversation?.suggestions).toMatchObject({ status: "idle", requestId: null, items: [] });
      const state = structuredClone(h.stored().state);
      await h.request(); await h.host.drainSuggestions(h.id);
      const saved = h.host.instance(h.id).conversation!.suggestions;
      expect(saved).toMatchObject({ status: "ready", items: ["询问守门人道路"] });
      expect(h.stored().state).toEqual(state);
      for (let i = 0; i < 3; i++) expect(h.host.instance(h.id).conversation?.suggestions).toEqual(saved);
      const restarted = h.makeHost(); await restarted.drainSuggestions(h.id);
      expect(restarted.instance(h.id).conversation?.suggestions).toEqual(saved);
      expect(h.contexts).toHaveLength(1);
      await h.act("next-turn", "清点行装");
      await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(1);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "idle", items: [] });
      await h.request(); await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(2);
      expect(h.contexts[1]!.discourse).toMatchObject({ exchanges: [expect.objectContaining({ paragraphs: expect.any(Array) })] });
    } finally { await h.close(); }
  });

  it("replaces within one source, deduplicates requests and items, and retains the previous batch while pending", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(context => (context.previousSuggestions as string[]).length ? gate : { items: ["观察石门", "询问守门人"] });
    try {
      await h.request(); await h.host.drainSuggestions(h.id);
      const source = h.host.instance(h.id).conversation!.suggestions!;
      const input = { sourceId: source.sourceId, requestId: "replacement", expectedRequestId: source.requestId };
      await Promise.all([h.host.requestSuggestions(h.id, h.participantId, input), h.host.requestSuggestions(h.id, h.participantId, input)]);
      await expect.poll(() => h.contexts.length).toBe(2);
      expect(h.contexts[1]!.previousSuggestions).toEqual(source.items);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "generating", items: source.items });
      await expect(h.host.requestSuggestions(h.id, h.participantId, { ...input, requestId: "concurrent" })).rejects.toMatchObject({ status: 409 });
      release({ items: ["观察石门！", "整理探索打算", "  整理探索打算！"] });
      await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ sourceId: source.sourceId, requestId: "replacement", items: ["整理探索打算"] });
      await h.host.requestSuggestions(h.id, h.participantId, input);
      await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(2);
    } finally { release({ items: [] }); await h.close(); }
  });

  it("invalidates pending results on an action without starting another batch", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(() => gate);
    try {
      const old = h.host.instance(h.id).conversation!.suggestions!;
      await h.request(); await expect.poll(() => h.contexts.length).toBe(1);
      await h.act("while-suggesting", "清点行装");
      release({ items: ["过时的开场建议"] });
      await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "idle", items: [] });
      expect(h.contexts).toHaveLength(1);
      await expect(h.host.requestSuggestions(h.id, h.participantId, {
        sourceId: old.sourceId, requestId: "late-request", expectedRequestId: old.requestId,
      })).rejects.toMatchObject({ status: 409 });
    } finally { release({ items: [] }); await h.close(); }
  });

  it("requires ownership and keeps control changes idle while discarding the released player's result", async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    const h = await harness(context => (context.perspective as { self: { name: string } }).self.name === "测试旅人"
      ? gate : { items: ["留意石门前的访客"] });
    try {
      const source = h.host.instance(h.id).conversation!.suggestions!;
      await expect(h.host.requestSuggestions(h.id, h.participantId, {
        sourceId: source.sourceId, requestId: "unauthorized", expectedRequestId: null,
      }, "another-principal")).rejects.toMatchObject({ status: 404 });
      await h.request(); await expect.poll(() => h.contexts.length).toBe(1);
      const next = await h.host.transferControl(h.id, { expectedRevision: h.stored().state.revision, target: { kind: "agent", agentId: "keeper" } });
      release({ items: ["旧角色建议"] }); await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.participantId).toBe(next.conversation!.participantId);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "idle", items: [] });
      expect(h.contexts).toHaveLength(1);
      await h.request(); await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions?.items).toEqual(["留意石门前的访客"]);
      expect(JSON.stringify(h.contexts[1])).not.toContain("找到石门后的道路");
    } finally { release({ items: [] }); await h.close(); }
  });

  it("preserves a prior batch on refresh failure and permits explicit retry only", async () => {
    let fail = false;
    const h = await harness(() => { if (fail) throw new Error("suggestion unavailable"); return { items: ["观察石门"] }; });
    try {
      await h.request(); await h.host.drainSuggestions(h.id);
      const state = structuredClone(h.stored().state);
      fail = true; await h.request(); await h.host.drainSuggestions(h.id);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "failed", items: ["观察石门"] });
      expect(h.stored().state).toEqual(state);
      expect(h.host.instance(h.id).servicePause).toBeUndefined();
      const restarted = h.makeHost(); await restarted.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(2);
      fail = false; await h.request(); await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(3);
      expect(h.host.instance(h.id).conversation?.suggestions).toMatchObject({ status: "ready", items: [] });
    } finally { await h.close(); }
  });

  it.each(["queued", "generating"] as const)("recovers interrupted %s without inference or loss of the previous batch", async status => {
    const h = await harness(() => ({ items: ["观察石门"] }));
    try {
      await h.request(); await h.host.drainSuggestions(h.id);
      const stored = h.database.readInstance(h.id);
      stored.document.participants[h.participantId]!.suggestions = {
        ...stored.document.participants[h.participantId]!.suggestions!, status, requestId: "interrupted", executionId: null,
      };
      h.database.compareAndSwapInstance(h.id, stored.generation, stored.document);
      const restarted = h.makeHost(); await restarted.drainSuggestions(h.id);
      expect(restarted.instance(h.id).conversation?.suggestions).toMatchObject({ status: "failed", items: ["观察石门"] });
      expect(h.contexts).toHaveLength(1);
    } finally { await h.close(); }
  });

  it("excludes unintroduced Blackmarsh descriptions and records disabled reasoning on the actual creation request", async () => {
    const h = await harness(() => ({ items: ["查看行会旗帜的标识"] }), true);
    try {
      await h.request(); await h.host.drainSuggestions(h.id);
      expect(h.contexts).toHaveLength(1);
      const context = JSON.stringify(h.contexts[0]);
      expect(context).toContain("行会旗帜");
      for (const forbidden of ["Merry Legs", "Viz", "canonicalEntityIds", "localEntityId", "knowledge", "mechanics"]) expect(context).not.toContain(forbidden);
      const execution = h.database.executions({ instanceId: h.id }).find(row => row.manifest.id === "action-suggestions")!;
      expect(execution.status).toBe("succeeded");
      const serialized = h.database.executionEvents(execution.id).find(event => event.event === "model.context.serialized")!;
      expect(serialized.payload).toMatchObject({ profileId: "creation-deepseek", inferenceOverrides: { thinking: "disabled", effort: "auto" }, resolvedInference: { thinking: "disabled" } });
      const wire = h.provider.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
        .find(body => !body.questions && directCreationContext(body).task === "action-suggestions");
      expect(wire.thinking).toEqual({ type: "disabled" });
      expect(wire).not.toHaveProperty("reasoning_effort");
    } finally { await h.close(); }
  });
});
