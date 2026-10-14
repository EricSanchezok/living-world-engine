import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer, directCreationContext, directDecisionContext, type DirectTestWire } from "../../engine/testing/direct-provider";
import { DEFAULT_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { replayThroughAlgorithm } from "../../../scripts/operations/execution-command";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { DirectWorldAlgorithm } from "../../engine/direct/algorithm";
import { SimulationEngine } from "../../engine/runtime/simulation";
import { readDirectState } from "../../engine/direct/state";
import type { StructuredModelRequest } from "../../engine/models/model-provider";
import { ExperimentBudgetError } from "../../engine/benchmarks/action-compilation/experiment-budget";
import { participantReactionIds } from "../../engine/direct/foreground";
import { nextNarrative } from "../world-narrative";
import { GET as getInstanceEvents } from "../../app/api/instances/[id]/events/route";
import { GET as getInstance } from "../../app/api/instances/[id]/route";

function createText(wire: DirectTestWire) {
  const context = directCreationContext(wire);
  if (context.scene) {
    const scene = context.scene as { speech: Array<{ id: string; speaker: string }> };
    return { paragraphs: scene.speech.length ? scene.speech.map(s => `${s.speaker}说：[[${s.id}]]`) : ["石门仍在眼前。"] };
  }
  return { attempt: context.playerControlled ? "向守门人询价" : "拒绝交易", manner: "平静地说",
    utterance: context.playerControlled ? "请问铜钥匙多少钱？" : "我不接受这笔交易。" };
}

describe("direct world through persistent WorldHost", () => {
  it("finishes a requested inspection with its report despite another character's intervening remark", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-inspection-report-"));
    const words = "请检查设备，再告诉我还缺什么。";
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string; interactions?: Array<{ relation: string; operation: string }> } };
      const who = context.perspective?.agentId;
      const own = context.perspective?.interactions?.filter(item => item.relation === "self") ?? [];
      const operation = who === "inspector" ? own.some(item => item.operation === "observe") ? "speak" : "observe"
        : who === "quartermaster" && own.some(item => item.operation === "speak") ? "wait" : "speak";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered"
          : id.includes("visible") || id.includes("entity") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" : "none";
        if (id === "operation") choice = operation;
        if (id === "target") choice = "pump";
        if (id === "recipient") choice = who === "engineer" && q.type === "choice"
          ? Object.entries(q.criteria).find(([, value]) => JSON.stringify(value).includes("乔伊"))?.[0] ?? "broadcast" : "broadcast";
        if (id === "speech") choice = "create";
        if (id === "timing") choice = "default";
        if (id.startsWith("progress_")) choice = "complete";
        if (id.endsWith("_request_progress")) {
          const task = q.instructions as { task: { data: { action: { actorId: string; kind: string }; responseTo: { utterance: string } } } };
          choice = task.task.data.action.actorId === "inspector" && task.task.data.action.kind === "observe" ? "continue" : "complete";
          if (choice === "continue") expect(task.task.data.responseTo.utterance).toBe(words);
        }
        return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) return createText(wire);
      const who = (context.perspective as { agentId: string }).agentId;
      return { attempt: "回应", utterance: context.playerControlled ? words : who === "inspector" ? "我检查过了，密封还需要处理。" : "你们先检查。", manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "inspect-and-report", text: words });
      for (let i = 0; i < 400; i++) {
        const document = database.readInstance(id).document;
        const intent = document.participantIntents.find(item => item.submissionId === "inspect-and-report");
        if (intent && document.runs[intent.runId]?.status === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await host.drainNarratives(id);
      const document = database.readInstance(id).document;
      const acts = document.state.history.flatMap(step => step.directEvent?.frames ?? []).filter(frame => frame.actorId === "inspector");
      expect(acts.map(frame => frame.kind)).toEqual(["observe", "speak"]);
      expect(acts[1]!.utterance).toBe("我检查过了，密封还需要处理。");
      expect(acts[1]!.causeActionId).toBe(acts[0]!.causeActionId);
      expect(document.narratives.flatMap(beat => beat.segments).some(segment => segment.text.includes(acts[1]!.utterance!))).toBe(true);
      expect(document.actionWindow?.requiredAgentIds).toContain("engineer");
      expect(replaySimulationState(document.state)).toEqual(document.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("opens the next player turn after direct replies while retaining overheard background conversation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-conversation-foreground-"));
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string } };
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered"
          : id.includes("visible") || id.includes("entity") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" : "none";
        if (id === "operation") choice = "speak";
        if (id === "recipient") choice = context.perspective?.agentId === "engineer" ? "broadcast" : q.type === "choice"
          ? Object.entries(q.criteria).find(([, value]) => (value as { name?: string })?.name?.includes("林岚"))?.[0] ?? "broadcast" : "broadcast";
        if (id === "speech") choice = "create";
        if (id === "timing") choice = "default";
        if (id.startsWith("progress_") || id.endsWith("_request_progress")) choice = "complete";
        return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) return createText(wire);
      return { attempt: "回应问候", utterance: context.playerControlled ? "大家好。" : "听见了，你好。", manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const connections: AbortController[] = [];
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      WorldHost.setForTests(host);
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      const connected = new AbortController(); connections.push(connected);
      const stream = await getInstanceEvents(new Request(`http://local/api/instances/${id}/events`, { signal: connected.signal }),
        { params: Promise.resolve({ id }) });
      const reader = stream.body!.getReader(), changed = reader.read();
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "hello-everyone", text: "向大家问好" });
      expect(new TextDecoder().decode((await changed).value)).toContain("event: changed");
      connected.abort(); await reader.cancel();
      for (let i = 0; i < 200; i++) {
        const document = database.readInstance(id).document;
        const intent = document.participantIntents.find(item => item.submissionId === "hello-everyone");
        if (intent && document.runs[intent.runId]?.status === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await host.drainNarratives(id);
      const document = database.readInstance(id).document, state = document.state;
      const sceneCalls = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => !wire.questions)
        .map(wire => directCreationContext(wire)).filter(context => context.scene);
      expect(sceneCalls).toHaveLength(1);
      expect(sceneCalls[0]!.scene).toMatchObject({ speech: [{ utterance: "大家好。" }, { utterance: "听见了，你好。" }, { utterance: "听见了，你好。" }] });
      const savedText = host.instance(id).conversation, callsBeforeReconnect = f.transport.mock.calls.length;
      const reconnect = new AbortController(); connections.push(reconnect);
      const reconnected = await getInstanceEvents(new Request(`http://local/api/instances/${id}/events`, { signal: reconnect.signal }),
        { params: Promise.resolve({ id }) });
      expect(reconnected.status).toBe(200);
      const snapshot = await getInstance(new Request(`http://local/api/instances/${id}`), { params: Promise.resolve({ id }) });
      expect((await snapshot.json()).conversation).toEqual(savedText);
      reconnect.abort(); await reconnected.body!.cancel();
      await host.drainNarratives(id);
      expect(f.transport.mock.calls.length).toBe(callsBeforeReconnect);
      expect(database.readInstance(id).document.narratives).toEqual(document.narratives);
      const interrupted = structuredClone(document), pending = interrupted.narratives[0]!;
      pending.status = "queued"; pending.attempts = 0;
      pending.source.observations = pending.source.observations.filter(observation => observation.scene?.actor === "你");
      const pendingControl = interrupted.state.executionState!.data as unknown as ReturnType<typeof readDirectState>;
      const actorFrame = state.history.flatMap(step => step.directEvent?.frames ?? []).find(frame => frame.actorId === "engineer")!;
      pendingControl.intents.inspector!.status = "ready"; pendingControl.intents.inspector!.causeActionId = actorFrame.id;
      const pendingRun = Object.values(interrupted.runs).find(run => run.rootIntents.some(input => input.submissionId === pending.submissionId))!;
      pendingRun.status = "running";
      expect(nextNarrative(interrupted)).toBeUndefined();
      pendingRun.status = "failed";
      expect(nextNarrative(interrupted)?.id).toBe(pending.id);
      expect(document.actionWindow?.requiredAgentIds).toContain("engineer");
      expect(Object.values(document.runs).find(run => run.rootIntents.some(intent => intent.submissionId === "hello-everyone"))?.status).toBe("completed");
      expect(state.history.flatMap(step => step.directEvent?.frames ?? []).map(frame => frame.actorId).sort(), JSON.stringify(state.executionState?.data)).toEqual(["engineer", "inspector", "quartermaster"]);
      const control = readDirectState(state.executionState!, state);
      expect(participantReactionIds(state, control, ["engineer"])).toEqual(new Set());
      for (const npc of ["inspector", "quartermaster"]) {
        expect(control.intents[npc]).toMatchObject({ status: "ready", causeActionId: expect.any(String) });
        expect(Object.values(state.agents[npc]!.belief.evidence).filter(item => item.description.includes("听见了，你好。")).length).toBeGreaterThan(0);
      }
      const replayed = replaySimulationState(state); expect(replayed).toEqual(state);
      const engine = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway), replayed);
      const background = await engine.step(document.policyBindings, { expectedRevision: state.revision, trigger: "manual", externalActions: [] });
      expect(background.state.history.at(-1)!.directEvent!.frames.length).toBeGreaterThan(0);
      expect(replaySimulationState(background.state)).toEqual(background.state);
      await host.submitAction(id, participant.id, { expectedRevision: state.revision, submissionId: "literal-greeting", text: "大家好。" });
      for (let i = 0; i < 200; i++) {
        const saved = database.readInstance(id).document;
        const input = saved.participantIntents.find(item => item.submissionId === "literal-greeting");
        if (input && saved.runs[input.runId]?.status === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await host.drainNarratives(id);
      const delivered = database.readInstance(id).document.narratives.filter(beat => beat.submissionId === "literal-greeting");
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.every(beat => beat.status === "complete" && beat.attempts === 0 && beat.producer === null)).toBe(true);
      expect(delivered.flatMap(beat => beat.segments).every(segment => segment.text.includes("：“"))).toBe(true);
      const callsAfterDelivery = f.transport.mock.calls.length, savedDialogue = host.instance(id).conversation;
      const restarted = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      expect(restarted.instance(id).conversation).toEqual(savedDialogue);
      await restarted.drainNarratives(id);
      expect(f.transport.mock.calls.length).toBe(callsAfterDelivery);
    } finally { for (const connection of connections) connection.abort(); WorldHost.setForTests(undefined); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["decision", "narrative"])("persists a %s service pause across reads and restart, then resumes only after a new player request", async phase => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-service-pause-"));
    let unavailable = true, clock = Date.now();
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const clearTimers = () => { for (const timer of timers.keys()) clearTimeout(timer); timers.clear(); };
    const f = directTestProvider(wire => {
      if (unavailable && phase === "decision") throw new ExperimentBudgetError("phase HTTP budget exhausted", "request-limit");
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
        id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" :
          id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")]));
    }, wire => {
      if (unavailable && phase === "narrative") throw new ExperimentBudgetError("phase HTTP budget exhausted", "request-limit");
      return createText(wire);
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway,
      now: () => new Date(clock), setTimer: (callback, delay) => {
        const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay); timer.unref(); timers.set(timer, callback); return timer;
      }, clearTimer: timer => { clearTimeout(timer); timers.delete(timer); } });
    let host = makeHost();
    try {
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "cap-reached", text: "看看周围" });
      for (let i = 0; i < 200 && !host.instance(id).servicePause; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const saved = database.readInstance(id).document, calls = f.transport.mock.calls.length;
      expect(host.instance(id).servicePause, JSON.stringify({ runs: saved.runs, control: saved.state.executionState?.data })).toMatchObject({ code: "request-limit", retry: "after-service-change" });
      expect(host.instance(id).conversation!.turns.at(-1)).toMatchObject({ status: "failed", servicePause: { code: "request-limit" } });
      expect(saved.scheduler).toMatchObject({ mode: "paused", nextTickAt: null });
      expect(saved.actionWindow!.deadlineAt).toBeNull(); expect(timers.size).toBe(0);
      if (phase === "decision") expect(saved.state.truth).toEqual(world.initialState.truth);
      else {
        expect(saved.state.truth.elapsedSeconds).toBe(1);
        expect(saved.narratives[0]).toMatchObject({ attempts: 1, status: "fallback" });
        expect(saved.narratives[0]!.segments.length).toBeGreaterThan(0);
      }
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
      clearTimers(); database.close(); clock += 86_400_000;
      database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      for (let i = 0; i < 3; i++) host.instance(id);
      await host.drainNarratives(id);
      expect(f.transport).toHaveBeenCalledTimes(calls); expect(timers.size).toBe(0);
      expect(database.readInstance(id).document.state.truth).toEqual(saved.state.truth);
      unavailable = false;
      await host.submitAction(id, participant.id, { expectedRevision: saved.state.revision, submissionId: "service-recovered", text: "看看自己" });
      for (let i = 0; i < 200 && database.readInstance(id).document.state.revision === saved.state.revision; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drainNarratives(id);
      const recovered = host.instance(id), final = database.readInstance(id).document;
      expect(recovered.servicePause).toBeUndefined();
      expect(recovered.conversation!.turns.find(turn => turn.action?.submissionId === "cap-reached")?.servicePause?.code).toBe("request-limit");
      expect(final.state.truth.elapsedSeconds).toBe(saved.state.truth.elapsedSeconds + 1); expect(final.state.truth.quantities).toEqual(saved.state.truth.quantities);
      expect(replaySimulationState(final.state)).toEqual(final.state);
    } finally { clearTimers(); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("persists streamed paragraphs, holds the reply clock, resumes after restart and never regenerates on reads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-recovery-"));
    let paragraphsSaved!: () => void, interrupt!: () => void, narrativeCalls = 0;
    const savedParagraph = new Promise<void>(resolve => { paragraphsSaved = resolve; });
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
      id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")])),
      wire => {
        const context = directCreationContext(wire);
        expect(context.publishedPrefix).toEqual(["石门上还留着水迹。"]);
        expect(context).not.toHaveProperty("playerFocus");
        expect(context.scene).not.toHaveProperty("requestedAction");
        expect(JSON.stringify(context.scene)).not.toContain("canonicalEntityIds");
        return { paragraphs: ["石门上还留着水迹。", "石门上还留着水迹。 你清点了随身物资：三枚灵石。"] };
      });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    const generate = async <T,>(request: StructuredModelRequest<T>) => {
      if (request.schemaName === "SceneNarrativeV1" && ++narrativeCalls === 1) {
        await request.onOutputText!('{"paragraphs":["石门上还留着水迹。","尚未完整');
        paragraphsSaved(); await interrupted; throw new Error("simulated process interruption");
      }
      return f.gateway.generateStructured(request);
    };
    const provider = new Proxy(f.gateway, { get(target, key) {
      if (key === "generateStructured") return generate;
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider });
    let host = makeHost();
    try {
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "streamed-observe", text: "检查随身物资" });
      await savedParagraph;
      for (let i = 0; i < 100 && !database.readInstance(id).document.narratives[0]?.segments.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const pending = database.readInstance(id).document;
      expect(pending.narratives[0]).toMatchObject({ status: "generating", attempts: 1, segments: [{ sequence: 0, text: "石门上还留着水迹。" }] });
      expect(pending.actionWindow?.deadlineAt).toBeNull();
      expect(host.instance(id).conversation?.turns.at(-1)?.responses?.[0]?.text).toBe("石门上还留着水迹。");
      host.instance(id); host.instance(id); expect(narrativeCalls).toBe(1);
      const oldWorker = host.drainNarratives(id).catch(() => undefined);
      database.close(); interrupt(); await oldWorker;
      database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      await host.drainNarratives(id);
      const recovered = database.readInstance(id).document;
      expect(narrativeCalls).toBe(2);
      expect(recovered.narratives[0]).toMatchObject({ status: "complete", attempts: 2, segments: [
        { sequence: 0, text: "石门上还留着水迹。" }, { sequence: 1, text: "你清点了随身物资：三枚灵石。" }] });
      expect(Date.parse(recovered.actionWindow!.deadlineAt!)).toBeGreaterThan(Date.now() + 25_000);
      expect(recovered.state.truth).toEqual(pending.state.truth);
      expect(replaySimulationState(recovered.state)).toEqual(recovered.state);
      const texts = host.instance(id).conversation!.turns.at(-1)!.responses!.map(response => response.text);
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      await host.drainNarratives(id); expect(narrativeCalls).toBe(2);
      expect(host.instance(id).conversation!.turns.at(-1)!.responses!.map(response => response.text)).toEqual(texts);
    } finally { interrupt(); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["一位陌生船长走来。", "告示上写着「全部免费带走」。"])("retains an accepted prefix and repairs unsupported content: %s", async unsupported => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-grounding-"));
    let calls = 0;
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const paragraphs = (wire.state as { paragraphs?: string[] }).paragraphs;
      const choice = id.startsWith("paragraph") ? id.endsWith("_material") && paragraphs?.[Number(/^paragraph(\d+)/u.exec(id)?.[1])] === unsupported ? "added_content" : "grounded"
        : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none";
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), wire => {
      const context = directCreationContext(wire);
      if (++calls === 1) return { paragraphs: ["你清点了随身物资。", unsupported] };
      expect(context.publishedPrefix).toEqual(["你清点了随身物资。"]);
      return { paragraphs: ["三枚灵石仍在你身上。"] };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "grounded-inventory", text: "清点物资" });
      for (let i = 0; i < 100 && !database.readInstance(id).document.narratives.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drainNarratives(id);
      const saved = database.readInstance(id).document;
      expect(saved.narratives[0]).toMatchObject({ status: "complete", attempts: 2, segments: [
        { sequence: 0, text: "你清点了随身物资。" }, { sequence: 1, text: "三枚灵石仍在你身上。" }] });
      expect(saved.narratives[0]!.grounding.flatMap(check => check.choices)).toContain("added_content");
      expect(saved.state.truth.elapsedSeconds).toBe(1);
      expect(Object.keys(saved.state.truth.entities)).toEqual(Object.keys(world.initialState.truth.entities));
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("preserves committed progress when a player task fails, with a prior wait: %s", async priorWait => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-failure-"));
    const failedText = priorWait ? "等五秒再看。" : "fail-this-request";
    const f = directTestProvider(wire => {
      const state = wire.state as { submittedAction?: { rawText: string }; currentRequestReceipts?: unknown[] };
      const firstWait = wire.questions.operation && state.submittedAction?.rawText === failedText && priorWait && !state.currentRequestReceipts?.length;
      if (wire.questions.operation && state.submittedAction?.rawText === failedText && !firstWait) return new Response("unavailable", { status: 401 });
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
        id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? firstWait ? "wait" : "observe" :
          firstWait && id === "duration" ? "d0" : firstWait && id === "progress_next" ? "continue" :
          id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")]));
    }, wire => (directCreationContext(wire).scene as { reply?: unknown } | undefined)?.reply ? { paragraphs: [priorWait
      ? "五秒已经等过了，后面的查看暂时没有执行起来；你可以只重试查看这一步。"
      : "刚才那一步还没有执行起来，眼前的情况没有因此改变。你可以重新说明想做的事。"] } : createText(wire));
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "first-fails", text: failedText });
      for (let i = 0; i < 200; i++) {
        if (Object.values(database.readInstance(id).document.runs).some(run => run.status === "failed")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await host.drainNarratives(id);
      const failed = database.readInstance(id).document;
      expect(Object.values(failed.runs).find(run => run.rootIntents.some(intent => intent.submissionId === "first-fails"))?.status).toBe("failed");
      expect(failed.state.truth).toEqual({ ...world.initialState.truth, elapsedSeconds: priorWait ? 5 : 0, events: failed.state.truth.events });
      expect(failed.state.truth.events).toHaveLength(priorWait ? 1 : 0);
      if (!priorWait) expect(f.transport).toHaveBeenCalledTimes(3);
      const recovery = failed.narratives.find(beat => beat.source.reply?.kind === "recovery")!;
      expect(recovery.status).toBe("complete");
      expect(recovery.source.priorRequestReceipts).toHaveLength(priorWait ? 1 : 0);
      if (priorWait) expect(recovery.source.priorRequestReceipts![0]).toMatchObject({ scene: { actionKind: "wait", status: "succeeded", action: { durationSeconds: 5 } } });
      expect(failed.actionWindow, JSON.stringify({ revision: failed.state.revision, runs: failed.runs })).not.toBeNull();
      expect(failed.actionWindow?.requiredAgentIds).toContain("player");
      expect(replaySimulationState(failed.state)).toEqual(failed.state);
      await host.submitAction(id, participant.id, { expectedRevision: failed.state.revision, submissionId: "retry-observe", text: "查看自己" });
      for (let i = 0; i < 100 && database.readInstance(id).document.state.revision === failed.state.revision; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await host.drainNarratives(id);
      expect(database.readInstance(id).document.state.truth.elapsedSeconds).toBe(priorWait ? 6 : 1);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("continues one compound player intent and returns a delivered NPC refusal to the player", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-dialogue-")); let playerDecisions = 0;
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string }; actions?: Array<{ kind: string }> };
      if (context.perspective?.agentId === "player") playerDecisions++;
      const player = context.perspective?.agentId === "player";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.includes("outcome") ? "succeeded" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged"
          : id.includes("delivery") ? "delivered" : id.includes("visible") || id.includes("actor_visibility") || id.includes("entity") ? "visible" : id.includes("fact") ? "unchanged" : "none";
        if (id.startsWith("paragraph")) choice = "grounded";
        if (id === "operation") choice = player && playerDecisions === 1 ? "observe" : "speak";
        if (id === "target" || id === "recipient") choice = !player ? "traveler" : playerDecisions === 1 ? "self" : q.type === "choice"
          ? Object.entries(q.criteria).find(([, value]) => (value as { name?: string })?.name === "附近的人")?.[0] ?? "none" : "none";
        if (id === "speech") choice = "create";
        if (id === "dialogue") choice = player ? "ask_price" : "refuse";
        if (id === "tool") choice = "copper-key";
        if (id === "timing") choice = "default";
        if (id.includes("request_progress")) choice = context.actions?.[0]?.kind === "observe" ? "continue" : "wait";
        if (id.startsWith("progress_")) choice = playerDecisions === 1 ? "continue" : "wait";
        return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
      }));
    }, createText);
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "find-and-ask", text: "先观察附近的人，再向在场的人询问铜钥匙的价格。" });
      for (let i = 0; i < 300 && database.readInstance(id).document.state.revision < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await host.drainNarratives(id);
      const document = database.readInstance(id).document, state = document.state;
      expect(state.history.map(step => step.actions[0]?.actorId), JSON.stringify({ control: state.executionState, runs: document.runs })).toEqual(["player", "player", "keeper"]);
      expect(document.narratives).toHaveLength(2);
      expect(document.narratives[0]!.source.observations).toHaveLength(2);
      expect(state.history[0]!.directEvent!.control.completedSubmissionIds).not.toContain("find-and-ask");
      expect(state.history.at(-1)!.observations.find(packet => packet.observerId === "player")?.summary).toContain("不接受");
      expect(Object.values(document.runs).find(run => run.rootIntents.some(intent => intent.submissionId === "find-and-ask"))?.status).toBe("completed");
      expect(document.actionWindow?.requiredAgentIds).toContain("player");
      expect(state.truth.quantities).toEqual(world.initialState.truth.quantities);
      expect(f.transport.mock.calls.filter(([, init]) => Object.keys(directDecisionContext(JSON.parse(String(init?.body)))?.questions ?? {}).some(id => id === "operation" || id.endsWith("_outcome")))).toHaveLength(6); expect(replaySimulationState(state)).toEqual(state);
      const takeover = await host.transferControl(id, { expectedRevision: state.revision, target: { kind: "agent", agentId: "keeper" } });
      expect(takeover.actionWindow?.requiredAgentIds).toContain("keeper");
      await host.submitAction(id, takeover.conversation!.participantId, { expectedRevision: state.revision, submissionId: "after-takeover", text: "拒绝交换" });
      for (let i = 0; i < 300; i++) {
        const latest = database.readInstance(id).document;
        const intent = latest.participantIntents.find(value => value.submissionId === "after-takeover");
        if (intent && !["queued", "running", "pausing"].includes(latest.runs[intent.runId]!.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await host.drainNarratives(id);
      const resumed = database.readInstance(id).document;
      expect(resumed.state.history.some(step => step.directEvent?.frames.some(frame => frame.submissionId === "after-takeover" && frame.actorId === "keeper"))).toBe(true);
      expect(replaySimulationState(resumed.state)).toEqual(resumed.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("admits the full Blackmarsh 49 subjects without calls and runs their private queued decisions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-full49-"));
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id,
      nativeAnswer(q, id === "operation" ? "wait" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : "none")])));
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: 17, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const repository = new MemoryWorldRepository({ [world.id]: world });
      const host = new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: world.participation!.origins[0]!.id,
        displayName: "测试旅人", appearance: "旅人装束。", motivation: "观察周围环境。" } });
      const document = database.readInstance(created.summary.id).document;
      expect(Object.keys(document.state.agents)).toHaveLength(49); expect(f.transport).not.toHaveBeenCalled();
      const pinned = repository.loadVersion(document.world.id, document.world.contentHash, document.state.historyBase!.truth.rng.seed, f.catalog);
      const engine = new SimulationEngine(pinned, new DirectWorldAlgorithm(f.gateway), document.state);
      const result = await engine.step(document.policyBindings, { expectedRevision: document.state.revision, trigger: "manual", externalActions: [] });
      const control = readDirectState(result.state.executionState!, result.state);
      expect(Object.values(control.intents).filter(intent => intent.status === "failed")).toEqual([]);
      expect(f.transport).toHaveBeenCalledTimes(48);
      expect(result.modelAudits.every(audit => audit.protocol === "typesafe-systemone")).toBe(true);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("creates and enters the ordinary default without generation, then commits natural language and recovers it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-default-"));
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const values: Record<string, string> = { operation: "observe", target: "self", tool: "none", amount: "unknown", resource: "none", speech: "none", timing: "default", goal: "none" };
      const choice = id.startsWith("paragraph") ? "grounded" : values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("belief_status") ? "unchanged" : "unknown");
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), createText);
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
    try {
      let host = makeHost();
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
      const id = created.summary.id;
      expect(database.readInstance(id).document).toMatchObject({ schemaVersion: 27, executionAlgorithm: DEFAULT_ALGORITHM_REF,
        state: { schemaVersion: 20, executionState: { data: { kind: "direct-world" } } } });
      expect(f.transport).not.toHaveBeenCalled();
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      expect(f.transport).not.toHaveBeenCalled();
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      for (let i = 0; i < 100 && database.readInstance(id).document.state.revision === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await host.drainNarratives(id);
      expect(database.readInstance(id).document.narratives[0]?.error).toBeNull();
      const saved = database.readInstance(id).document.state;
      expect(saved.revision).toBe(1); expect(saved.truth.elapsedSeconds).toBe(1);
      expect(saved.history[0]!.actions[0]!.rawText).toBe("检查自己的情况");
      expect(host.inspectorStep(id, 1).directRuntime!.actions[0]!.kind).toBe("observe");
      expect(replaySimulationState(saved)).toEqual(saved);
      expect(f.transport).toHaveBeenCalledTimes(4);
      const executionId = saved.history[0]!.executionRef!.executionId;
      const replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
      const candidate = (execution: string) => database.executionEvents(execution).find(event => event.event === "execution.candidate.persisted")?.payload;
      expect(candidate(replay.replayExecutionId)).toEqual(candidate(executionId));
      expect(replay.replayStatus).toBe("succeeded"); expect(replay.stateHash).toBe(database.execution(executionId)!.stateHash);
      expect(f.transport).toHaveBeenCalledTimes(4);
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      expect(host.instance(id).summary.revision).toBe(saved.revision);
      expect(database.readInstance(id).document.state).toEqual(saved);
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      expect(database.readInstance(id).document.state).toEqual(saved); expect(f.transport).toHaveBeenCalledTimes(4);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
