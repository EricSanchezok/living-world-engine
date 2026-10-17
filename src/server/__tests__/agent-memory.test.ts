import path from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, directCreationContext, nativeAnswer } from "../../engine/testing/direct-provider";
import { contentHash } from "../../engine/models/model-audit";
import { MemoryContextChanged, readAgentMemory, requestMemoryVersions, withFreshMemory } from "../../engine/cognition/memory";
import { privateActionView } from "../../engine/direct/views";
import { executeDecisionV2 } from "../../engine/models/decision-v2";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { AgentMemoryService } from "../agent-memory";
import type { WorldInstanceDocument } from "../world-instance-types";
import { readDirectState } from "../../engine/direct/state";
import { replayThroughAlgorithm } from "../../../scripts/operations/execution-command";

function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(create: (context: Record<string, unknown>) => unknown | Promise<unknown>, maxInputBytes?: number, observePlayer = false) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-memory-"));
  const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
    id === "operation" ? observePlayer && (wire.state as { submittedAction?: unknown }).submittedAction ? "observe" : "wait"
      : id === "expression" ? 0 : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")])), wire => create(directCreationContext(wire)), { maxInputBytes });
  await f.registry.capture();
  const script = path.join(root, "world"); cpSync(path.resolve("test/fixtures/open-world-script"), script, { recursive: true });
  for (const id of ["keeper", "player"]) {
    const file = path.join(script, "entities", `${id}.yaml`), entity = parse(readFileSync(file, "utf8"));
    const evidence = id === "keeper" ? Array.from({ length: 20 }, (_, i) => ({
      id: `m${i.toString().padStart(2, "0")}`, step: 0, sourceId: null, kind: "testimony",
      description: i === 0 ? "林舟救过我，三日后归还 17 枚银币，暗号青鹭归巢。" : "普通路人谈论天气。".repeat(100),
    })) : [{ id: "unshared", step: 0, sourceId: null, kind: "assumption", description: "PRIVATE-OTHER-SECRET" }];
    entity.agent.belief.evidence.push(...evidence); writeFileSync(file, stringify(entity));
  }
  const world = loadWorldScript(script, { seed: 2, modelCatalog: f.catalog });
  const db = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: db, ledger: db, provider: f.gateway });
  const id = (await host.createInstance({ worldId: world.id, start: { kind: "observer" } })).summary.id;
  const update = (change: (doc: WorldInstanceDocument) => boolean) => {
    const stored = db.readInstance(id), next = structuredClone(stored.document);
    if (!change(next)) return false;
    db.compareAndSwapInstance(id, stored.generation, next); return true;
  };
  const build = () => new AgentMemoryService(f.gateway, { read: () => db.readInstance(id).document,
    update: async (_id, change) => update(change), begin: document => ({ id: null, scope: { workloadId: id, batchId: "memory", runtimeIdentity: { worldHash: document.state.worldHash, revision: document.state.revision } } }), fail: () => {} });
  return { root, f, db, host, world, id, update, build, read: () => db.readInstance(id).document,
    close: () => { db.close(); rmSync(root, { force: true, recursive: true }); } };
}
const measurement = (ratio: number) => ({ ratio, estimatedInputTokens: Math.round(ratio * 32000), inputLimit: 32000 });

describe("background memory persistence", () => {
  it("merges a frozen prefix while the same Agent receives a real new observation", async () => {
    const started = latch(), gate = latch();
    const f = await fixture(async context => {
      if (!context.episodes) return { paragraphs: ["你看清了随身物品。"] };
      started.release(); await gate.promise;
      return { summary: "普通往来已归纳。", retainEvidenceIds: ["m00"], retainClaimIds: [] };
    }, undefined, true);
    try {
      const controlled = await f.host.transferControl(f.id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } });
      const service = f.build(), source = f.read();
      await service.scope(source).pressure(["keeper"], measurement(0.8)); await started.promise;
      await f.host.submitAction(f.id, controlled.conversation!.participantId,
        { expectedRevision: 0, submissionId: "during-compaction", text: "看看自己身上带着的物品。" });
      await expect.poll(() => f.read().state.revision).toBeGreaterThan(0);
      await f.host.drainNarratives(f.id);
      const concurrent = f.read().state;
      const appended = Object.keys(concurrent.agents.keeper!.belief.evidence).filter(id => !source.state.agents.keeper!.belief.evidence[id]);
      expect(appended.length).toBeGreaterThan(0);
      gate.release(); await service.drain(f.id);
      const saved = f.read();
      expect(contentHash(saved.state)).toBe(contentHash(concurrent));
      const memory = readAgentMemory(saved.state, saved.state.agents.keeper!, saved.agentMemories.keeper?.checkpoint);
      expect(memory.version).toBe(1);
      expect(memory.evidence.map(item => item.id)).toEqual(expect.arrayContaining(appended));
      expect(memory.important.some(item => item.evidence.id === "m00")).toBe(true);
    } finally { gate.release(); f.close(); }
  });
  it("compacts and retries through WorldHost's real engine observer, then replays without model calls", async () => {
    const f = await fixture(() => ({ summary: "普通往来已归纳。", retainEvidenceIds: ["m00"], retainClaimIds: [] }), 100000);
    try {
      await f.host.advance(f.id, { expectedRevision: 0, trigger: "manual" });
      await f.host.drainMemories(f.id);
      const saved = f.read();
      expect(saved.agentMemories.keeper?.checkpoint?.version).toBe(1);
      expect(readDirectState(saved.state.executionState!, saved.state).intents.keeper?.failure).toBeNull();
      const execution = f.db.executions({ instanceId: f.id }).findLast(item =>
        f.db.executionEvents(item.id).some(event => event.event === "model.memory.context.retry"));
      expect(execution).toBeDefined();
      const events = f.db.executionEvents(execution!.id);
      expect(events.some(event => event.event === "model.memory.pressure")).toBe(true);
      const retry = events.find(event => event.event === "model.memory.context.retry")!;
      const preflightId = (retry.payload as { modelInvocationId: string }).modelInvocationId;
      expect(events.filter(event => event.correlation?.modelInvocationId === preflightId)).toEqual([]);
      const calls = f.f.transport.mock.calls.length;
      const replay = await replayThroughAlgorithm(f.db, execution!, events);
      expect(replay.replayStatus).toBe("succeeded");
      expect(f.f.transport.mock.calls.length).toBe(calls);
    } finally { f.close(); }
  });
  it("starts exactly at 80%, single-flights, preserves concurrent instance updates, and reuses a checkpoint after restart", async () => {
    const started = latch(), gate = latch(); let count = 0;
    const f = await fixture(async context => { count++; expect(JSON.stringify(context)).not.toContain("PRIVATE-OTHER-SECRET"); started.release(); await gate.promise;
      return { summary: "守门人听过许多普通天气闲谈。", retainEvidenceIds: ["m00"], retainClaimIds: [] }; });
    try {
      const service = f.build(), source = f.read(), access = service.scope(source), initial = contentHash(source.state);
      await access.pressure(["keeper"], measurement(0.799)); await service.drain(f.id); expect(count).toBe(0);
      await access.pressure(["keeper"], measurement(0.8)); await started.promise;
      await access.pressure(["keeper"], measurement(0.95)); expect(count).toBe(1);
      f.update(doc => { doc.title = "Concurrent title update"; return true; });
      const concurrent = contentHash(f.read().state);
      expect(concurrent).toBe(initial); gate.release(); await service.drain(f.id);
      const saved = f.read(); expect(contentHash(saved.state)).toBe(concurrent); expect(saved.state.revision).toBe(source.state.revision);
      expect(saved.agentMemories.keeper?.checkpoint?.version).toBe(1);
      const restarted = f.build(), view = privateActionView(saved.state, "keeper", null, restarted.scope(saved));
      expect(JSON.stringify(view.state)).toContain("青鹭归巢"); expect(saved.title).toBe("Concurrent title update");
      expect(JSON.stringify(view.state)).not.toContain("PRIVATE-OTHER-SECRET"); expect(count).toBe(1);
      expect(f.db.readInstance(f.id).generation).toBeGreaterThan(1);
      f.update(doc => { doc.agentMemories.keeper!.attempt = { sourceHash: "interrupted", status: "generating", executionId: null, error: null }; return true; });
      new WorldHost({ repository: new MemoryWorldRepository({ [f.world.id]: f.world }), store: f.db, ledger: f.db, provider: f.f.gateway });
      expect(f.read().agentMemories.keeper!.checkpoint).toEqual(saved.agentMemories.keeper!.checkpoint);
      expect(f.read().agentMemories.keeper!.attempt).toBeNull();
      expect(count).toBe(1);
    } finally { gate.release(); f.close(); }
  });
  it("waits at capacity then rebuilds the complete real model request, and never loops on failure", async () => {
    const f = await fixture(() => ({ summary: "普通往来已归纳。", retainEvidenceIds: ["m00"], retainClaimIds: [] }));
    try {
      const service = f.build(), source = f.read(), access = service.scope(source);
      const original = privateActionView(source.state, "keeper", null, access).state;
      await expect(access.pressure(["keeper"], measurement(1), undefined, requestMemoryVersions(original))).rejects.toBeInstanceOf(MemoryContextChanged);
      const view = JSON.parse(JSON.stringify(privateActionView(source.state, "keeper", null, access).state));
      expect(requestMemoryVersions(view)).toEqual({ keeper: 1 });
      await executeDecisionV2(f.f.gateway, { workloadId: f.id, batchId: "recall", runtimeIdentity: { worldHash: source.state.worldHash, revision: source.state.revision }, subjectId: "keeper", profileId: "decision-jev", memory: access,
        batch: { version: 2, view: { kind: "agent", agentId: "keeper", projectionHash: contentHash(view) }, state: view, dependencies: {},
          questions: { remembers: { type: "choice", version: "1", instructions: "Who helped you, what do you owe, and what is the code?", criteria: { recalled: "林舟 / 17 / 青鹭归巢", unknown: "Unknown" } } } } });
      const wire = JSON.parse(String(f.f.transport.mock.calls.at(-1)![1]!.body));
      expect(JSON.stringify(wire.state)).toContain("青鹭归巢");
      expect(JSON.stringify(wire.state).length).toBeLessThan(JSON.stringify(original).length);
      const failed = await fixture(() => ({ summary: "x".repeat(100000), retainEvidenceIds: [], retainClaimIds: [] }));
      try {
        const worker = failed.build(), a = worker.scope(failed.read());
        await expect(withFreshMemory(() => a.pressure(["keeper"], measurement(1)))).rejects.toThrow("all original memory is preserved");
        const calls = failed.f.transport.mock.calls.length;
        await a.pressure(["keeper"], measurement(0.9)); await worker.drain(failed.id);
        expect(failed.f.transport.mock.calls.length).toBe(calls); expect(failed.read().agentMemories.keeper?.checkpoint).toBeNull();
      } finally { failed.close(); }
    } finally { f.close(); }
  });
  it("rejects obsolete publications and keeps completed memory across process recovery", async () => {
    const start = latch(), gate = latch();
    const f = await fixture(async () => { start.release(); await gate.promise; return { summary: "普通往来。", retainEvidenceIds: [], retainClaimIds: [] }; });
    try {
      const service = f.build(); await service.scope(f.read()).pressure(["keeper"], measurement(0.8)); await start.promise;
      f.update(doc => { doc.agentMemories.keeper!.attempt!.sourceHash = "replacement-source"; return true; });
      gate.release(); await service.drain(f.id); expect(f.read().agentMemories.keeper!.checkpoint).toBeNull();
      const source = f.read(); const read = readAgentMemory(source.state, source.state.agents.keeper!, null);
      expect(read.evidence.some(item => item.id === "m00")).toBe(true);
    } finally { gate.release(); f.close(); }
  });
});
