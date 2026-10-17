import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer, directCreationContext, directDecisionContext, type DirectTestWire } from "../../engine/testing/direct-provider";
import { DEFAULT_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { candidatePartitions, replayThroughAlgorithm } from "../../../scripts/operations/execution-command";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { DirectWorldAlgorithm } from "../../engine/direct/algorithm";
import { SimulationEngine } from "../../engine/runtime/simulation";
import { directControlHistory } from "../../engine/direct/canonical";
import { readDirectState } from "../../engine/direct/state";
import type { StructuredModelRequest } from "../../engine/models/model-provider";
import { ExperimentBudgetError } from "../../engine/benchmarks/action-compilation/experiment-budget";
import { participantReactionIds } from "../../engine/direct/foreground";
import { nextNarrative } from "../narrative/outbox";
import { GET as getInstanceEvents } from "../../app/api/instances/[id]/events/route";
import { GET as getInstance } from "../../app/api/instances/[id]/route";
import { DebugCheckpointModelProvider } from "../debug-checkpoint-provider";
import type { SimulationState } from "../../engine/contracts/model";

// Conversation scenarios start with NPCs waiting; initiative has separate concurrent coverage.
function quietInitialNpcProvider(...args: Parameters<typeof directTestProvider>) {
  const [respond, ...rest] = args;
  return directTestProvider((wire, call) => {
    const context = wire.state as { submittedAction?: unknown; intent?: { wakeReasons: string[] } };
    if (!context.submittedAction && context.intent?.wakeReasons.includes("initial-decision")) {
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) =>
        [id, nativeAnswer(question, id === "operation" ? "wait" : "none")]));
    }
    return respond(wire, call);
  }, ...rest);
}

function executionCalls(calls: Array<Parameters<typeof fetch>>) {
  return calls.filter(([, init]) => {
    const wire = JSON.parse(String(init?.body));
    const task = wire.questions ? null : directCreationContext(wire).task;
    return wire.questions || task !== "action-suggestions" && (task as { kind?: string } | null)?.kind !== "arrival";
  });
}

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
  it("replays concurrent world components when their model responses finish in the opposite order", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-concurrent-replay-"));
    const f = directTestProvider(async wire => {
      if (!wire.questions) {
        const frame = directCreationContext(wire).requestedAction as { actorId: string };
        return { description: "A visible detail", entities: [], events: [], facts: [
          { subject: "actor", predicate: "visible-readiness", value: frame.actorId, description: `${frame.actorId}已经整理好衣着。` },
        ] };
      }
      const context = wire.state as { perspective?: { agentId: string }; actions?: Array<{ actorId: string }> };
      if (wire.questions.a0_outcome && context.actions?.[0]?.actorId === "keeper") await new Promise(resolve => setTimeout(resolve, 30));
      const values: Record<string, string> = { operation: "observe", target: "self", observation_scope: "inventory", tool: "none", resource: "none", amount: "unknown", speech: "none", timing: "default", duration: "default", goal: "none" };
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let value = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("duration") ? "s1"
          : id.endsWith("_world_expansion") ? "introduce" : id === "accept" ? "apply" : id.startsWith("coverage") ? "complete"
            : id.includes("visible") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" : "none");
        if (q.type === "choice" && !(value in q.criteria)) value = "none" in q.criteria ? "none" : Object.keys(q.criteria)[0]!;
        return [id, nativeAnswer(q, id === "expression" ? 0 : value)];
      }));
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
      await host.advance(created.summary.id, { expectedRevision: 0, trigger: "manual" });
      const saved = database.readInstance(created.summary.id).document.state;
      expect(saved.history[0]!.directEvent!.frames).toHaveLength(2);
      expect(Object.values(saved.truth.facts).filter(fact => fact.predicate === "visible-readiness")).toHaveLength(2);
      const executionId = saved.history[0]!.executionRef!.executionId;
      const calls = f.transport.mock.calls.length;
      const replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
      expect(replay.stateHash).toBe(database.execution(executionId)!.stateHash);
      expect(replay.semanticHash).toBe(database.execution(executionId)!.semanticHash);
      expect(f.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([0, 2])("settles quiescence without a pause or commit with %i external policies, and accepts the next action", async externalCount => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-quiescent-host-"));
    let clock = Date.now(), timerId = 0, operation = "wait";
    const timers = new Map<number, { delay: number; run: () => void }>();
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
      id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? operation :
        id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")])), createText);
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database,
      provider: f.gateway, maxActiveParticipants: 2, now: () => new Date(clock),
      setTimer: (run, delay) => { timers.set(++timerId, { delay, run }); return timerId as unknown as ReturnType<typeof setTimeout>; },
      clearTimer: timer => { timers.delete(timer as unknown as number); } });
    try {
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      if (externalCount) {
        await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } }, "first");
        await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "keeper" } }, "second");
      }
      const changes: string[] = [];
      const unsubscribe = host.subscribeInstanceChanges(id, () => { changes.push(host.instance(id).run?.status ?? "none"); });
      await host.advance(id, { expectedRevision: 0, trigger: "manual" });
      const flushTimer = async () => {
        const entry = timers.entries().next().value;
        expect(entry).toBeDefined();
        const [key, timer] = entry!; timers.delete(key); clock += timer.delay + 1;
        await timer.run(); await host.drainNarratives(id); await host.drainSuggestions(id);
      };
      for (let i = 0; i < 8 && host.instance(id).run?.stopReason !== "waiting-for-event"; i++) await flushTimer();
      const waiting = host.instance(id), saved = database.readInstance(id).document;
      const status = externalCount ? "awaiting-decision" : "completed";
      expect(waiting.run).toMatchObject({ status, stopReason: "waiting-for-event" });
      expect(waiting.actionWindow).toBeNull(); expect(timers.size).toBe(0);
      expect(changes).toContain(status); unsubscribe();
      const execution = database.execution(saved.runs[waiting.run!.id]!.executionIds.at(-1)!)!;
      expect(execution.status).toBe("succeeded"); expect(execution.commitRevision).toBeUndefined();
      expect(database.executionEvents(execution.id).some(event => event.event === "step.waiting")).toBe(true);
      const calls = f.transport.mock.calls.length;
      clock += 86_400_000;
      host.instance(id); await host.drainNarratives(id); await host.drainSuggestions(id);
      expect(database.readInstance(id).document.state).toEqual(saved.state); expect(f.transport).toHaveBeenCalledTimes(calls);
      await expect(host.resumeRun(id, { runId: waiting.run!.id, generation: waiting.run!.generation })).rejects.toThrow("cannot be resumed");
      if (externalCount) {
        operation = "observe";
        for (const principal of ["first", "second"]) {
          const participant = Object.values(saved.participants).find(item => item.principalId === principal)!;
          await host.submitAction(id, participant.id, { expectedRevision: saved.state.revision, submissionId: `after-wait-${principal}`, text: "看看周围" }, principal);
        }
        for (let i = 0; i < 4 && host.instance(id).summary.elapsedSeconds === saved.state.truth.elapsedSeconds; i++) await flushTimer();
        expect(host.instance(id).summary.elapsedSeconds).toBeGreaterThan(saved.state.truth.elapsedSeconds);
        expect(replaySimulationState(database.readInstance(id).document.state)).toEqual(database.readInstance(id).document.state);
      }
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([{ progress: "continue", reply: "speak", trigger: "speak" }, { progress: "complete", reply: "speak", trigger: "speak" }, { progress: "complete", reply: "wait", trigger: "speak" }, { progress: "complete", reply: "speak", trigger: "use" }])(
    "keeps a requested inspection's reply opportunity ($trigger: $progress → $reply) despite an intervening remark", async ({ progress: inspectionProgress, reply, trigger }) => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-inspection-report-"));
    const words = trigger === "speak" ? "请检查设备，再告诉我还缺什么。" : "松开扶在设备上的手。";
    const receivedWords = trigger === "speak" ? words : null;
    let replyChoices = 0;
    const f = quietInitialNpcProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string; respondingTo?: string | null; interactions?: Array<{ id: string; relation: string; operation: string; utterance: string | null }> } };
      const who = context.perspective?.agentId;
      const own = context.perspective?.interactions?.filter(item => item.relation === "self") ?? [];
      if (who === "inspector" && own.some(item => item.operation === "observe")) {
        replyChoices++;
        expect(context.perspective?.interactions?.find(item => item.id === context.perspective?.respondingTo))
          .toMatchObject({ utterance: receivedWords, operation: trigger });
      }
      const operation = who === "inspector" ? own.some(item => item.operation === "observe") ? reply : "observe"
        : who === "engineer" ? trigger : who === "quartermaster" && own.some(item => item.operation === "speak") ? "wait" : "speak";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered"
          : id.includes("visible") || id.includes("entity") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" : "none";
        if (id === "operation") choice = operation;
        if (id.endsWith("_expression")) choice = "no_change";
        if (id === "target") choice = "pump";
        if (id === "recipient") choice = who === "engineer" && q.type === "choice"
          ? Object.entries(q.criteria).find(([, value]) => JSON.stringify(value).includes("乔伊"))?.[0] ?? "broadcast" : "broadcast";
        if (id === "speech") choice = "create";
        if (id === "timing") choice = "default";
        if (id.startsWith("progress_")) choice = "complete";
        if (id.endsWith("_request_progress")) {
          const task = q.instructions as { task: { data: { actionId: string; responseTo: { utterance: string } } } };
          const action = (wire.state as { actions: Array<{ id: string; actorId: string; kind: string }> }).actions.find(item => item.id === task.task.data.actionId)!;
          const inspecting = action.actorId === "inspector" && action.kind === "observe";
          choice = inspecting ? inspectionProgress : "complete";
          if (inspecting) expect(task.task.data.responseTo.utterance).toBe(receivedWords);
        }
        return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) return createText(wire);
      const who = (context.perspective as { agentId: string }).agentId;
      return { attempt: "回应", utterance: context.playerControlled ? trigger === "speak" ? words : null : who === "inspector" ? "我检查过了，密封还需要处理。" : "你们先检查。", manner: null };
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
      expect(replyChoices).toBeGreaterThan(0);
      expect(acts.map(frame => frame.kind)).toEqual(reply === "speak" ? ["observe", "speak"] : ["observe"]);
      if (reply === "speak") {
        expect(acts[1]!.utterance).toBe("我检查过了，密封还需要处理。");
        expect(acts[1]!.causeActionId).toBe(acts[0]!.causeActionId);
        expect(document.narratives.flatMap(beat => beat.segments).some(segment => segment.text.includes(acts[1]!.utterance!))).toBe(true);
      }
      expect(document.actionWindow?.requiredAgentIds).toContain("engineer");
      expect(replaySimulationState(document.state)).toEqual(document.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("opens the next player turn after direct replies while retaining overheard background conversation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-conversation-foreground-"));
    let newBackgroundMessage = false;
    const f = quietInitialNpcProvider(wire => {
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
      return { attempt: "回应问候", utterance: context.playerControlled ? "大家好。" : newBackgroundMessage ? "这一班我继续值守。" : "听见了，你好。", manner: null };
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
      const repeated = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway), replayed);
      const quiet = await repeated.step(document.policyBindings, { expectedRevision: state.revision, trigger: "manual", externalActions: [] });
      expect(quiet.state.history.at(-1)!.directEvent!.frames).toEqual([]);
      expect(replaySimulationState(quiet.state)).toEqual(quiet.state);
      newBackgroundMessage = true;
      const engine = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway), replayed);
      const background = await engine.step(document.policyBindings, { expectedRevision: state.revision, trigger: "manual", externalActions: [] });
      expect(background.state.history.at(-1)!.directEvent!.frames.length).toBeGreaterThan(0);
      expect(replaySimulationState(background.state)).toEqual(background.state);
      newBackgroundMessage = false;
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
  it("keeps a new player request foreground while its listener finishes an older NPC-caused activity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-busy-cause-"));
    const requestWords = "杜衡，把一个密封组件交给我。";
    let phase = "greeting";
    const f = quietInitialNpcProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string; respondingTo?: string | null;
        interactions: Array<{ id: string; utterance: string | null }> }; actions?: Array<{ id: string; actorId: string; kind: string }> };
      const who = context.perspective?.agentId;
      const response = context.perspective?.interactions.find(item => item.id === context.perspective?.respondingTo);
      const handlingRequest = response?.utterance === requestWords;
      const operation = handlingRequest ? who === "quartermaster" ? "transfer" : "wait" : "speak";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered"
          : id.includes("visible") || id.includes("entity") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" : "none";
        if (id === "operation") choice = operation;
        if (id === "recipient") choice = who === "engineer" ? "broadcast" : "repair";
        if (id === "resource") choice = operation === "transfer" ? "seal-kit" : "none";
        if (id === "amount") choice = operation === "transfer" ? "n1" : "unknown";
        if (id === "speech") choice = "create";
        if (id === "timing") choice = "default";
        if (id.endsWith("_expression")) choice = "no_change";
        if (id.startsWith("progress_") || id.endsWith("_request_progress")) choice = "complete";
        if (id.endsWith("_duration")) {
          const instructions = q.instructions as { task: { data: { actionId: string } } };
          const action = context.actions?.find(item => item.id === instructions.task.data.actionId);
          choice = action?.actorId === "engineer" ? "s10" : action?.kind === "transfer" ? "s1" : "s30";
        }
        return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) return createText(wire);
      return { attempt: "回应眼前的话", utterance: context.playerControlled ? phase === "greeting" ? "大家好。" : requestWords
        : phase === "greeting" ? "你好，我们还在核对值班记录。" : "刚才那份值班记录的时间是准确的。", manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      const submit = async (submissionId: string, text: string) => {
        await host.submitAction(id, participant.id, { expectedRevision: host.instance(id).summary.revision, submissionId, text });
        for (let i = 0; i < 400; i++) {
          const saved = database.readInstance(id).document;
          const run = Object.values(saved.runs).find(item => item.rootIntents.some(input => input.submissionId === submissionId));
          if (run?.status === "completed" || run?.status === "failed") break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await host.drainNarratives(id);
      };
      await submit("greeting", "向大家问好。");
      const before = database.readInstance(id).document.state;
      const oldCause = readDirectState(before.executionState!, before).intents.quartermaster!.causeActionId;
      expect(oldCause).toBeTruthy();
      expect(before.history.flatMap(step => step.directEvent?.frames ?? []).find(frame => frame.id === oldCause))
        .toMatchObject({ actorId: "inspector", submissionId: null });
      phase = "handover";
      await submit("handover", requestWords);
      const document = database.readInstance(id).document, state = document.state;
      const frames = state.history.flatMap(step => step.directEvent?.frames ?? []);
      const requested = frames.find(frame => frame.submissionId === "handover")!;
      expect(frames.filter(frame => frame.actorId === "quartermaster" && frame.kind === "transfer"))
        .toMatchObject([{ causeActionId: requested.id, targetEntityId: "engineer", quantityDefinitionId: "seal-kit", amount: 1 }]);
      const busy = [...directControlHistory(state)].find(([, control]) => control.completedSubmissionIds.includes("handover") &&
        control.intents.quartermaster?.status === "active" && control.activities.some(frame => frame.actorId === "quartermaster" && frame.causeActionId === oldCause));
      expect(busy).toBeDefined();
      expect(busy![1].intents.quartermaster).toMatchObject({ causeActionId: oldCause, pendingCauseActionIds: [requested.id] });
      expect(participantReactionIds(state, busy![1], ["engineer"], ["handover"])).toEqual(new Set(["inspector", "quartermaster"]));
      expect(busy![1].activities.find(frame => frame.actorId === "quartermaster")).toMatchObject({ kind: "speak", causeActionId: oldCause, progressSeconds: 10 });
      const balance = (holder: string) => Object.values(state.truth.quantities).filter(item => item.holderId === holder && item.definitionId === "seal-kit").reduce((sum, item) => sum + item.amount, 0);
      expect(balance("quartermaster")).toBe(0); expect(balance("engineer")).toBe(1);
      expect(Object.values(document.runs).find(run => run.rootIntents.some(input => input.submissionId === "handover"))?.status).toBe("completed");
      expect(document.actionWindow?.requiredAgentIds).toContain("engineer");
      expect(replaySimulationState(state)).toEqual(state);
      for (const [, control] of directControlHistory(state)) {
        expect(control.intents.engineer).toMatchObject({ causeActionId: null, pendingCauseActionIds: [] });
      }
      const restored = replaySimulationState(state, busy![0]);
      expect(readDirectState(restored.executionState!, restored)).toEqual(busy![1]);
      expect(Object.values(restored.truth.quantities).filter(item => item.holderId === "engineer" && item.definitionId === "seal-kit")).toEqual([]);
      const resumed = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway), restored);
      const finishedOldWork = await resumed.step(document.policyBindings, { expectedRevision: restored.revision, trigger: "participant_action", externalActions: [] });
      expect(finishedOldWork.committed.directEvent.frames.find(frame => frame.actorId === "quartermaster"))
        .toMatchObject({ kind: "speak", causeActionId: oldCause });
      const queued = readDirectState(finishedOldWork.state.executionState!, finishedOldWork.state);
      expect(queued.intents.quartermaster!.causeActionId).toBe(requested.id);
      expect(queued.intents.quartermaster!.pendingCauseActionIds).toContain(finishedOldWork.committed.directEvent.frames.find(frame => frame.actorId === "inspector")!.id);
      const fulfilled = await resumed.step(document.policyBindings, { expectedRevision: finishedOldWork.state.revision, trigger: "participant_action", externalActions: [] });
      expect(fulfilled.committed.directEvent.frames.find(frame => frame.actorId === "quartermaster"))
        .toMatchObject({ kind: "transfer", causeActionId: requested.id, amount: 1 });
      expect(fulfilled.state.truth.quantities).toEqual(state.truth.quantities);
      expect(replaySimulationState(fulfilled.state)).toEqual(fulfilled.state);
      await host.transferControl(id, { expectedRevision: state.revision, target: { kind: "observer" } });
      const detached = database.readInstance(id).document;
      expect(detached.policyBindings.engineer?.kind).toBe("model");
      expect(readDirectState(detached.state.executionState!, detached.state).intents.engineer)
        .toMatchObject({ causeActionId: null, pendingCauseActionIds: [] });
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["decision", "narrative"])("persists a %s service pause across reads and restart, then resumes only after a new player request", async phase => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-service-pause-"));
    let unavailable = true, clock = Date.now();
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const clearTimers = () => { for (const timer of timers.keys()) clearTimeout(timer); timers.clear(); };
    const f = quietInitialNpcProvider(wire => {
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
  it.each(["service-pause", "local-failure"])("keeps a committed question visible when its NPC response cannot finish: %s", async mode => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-paused-reply-"));
    let proseCalls = 0;
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const player = (wire.state as { perspective?: { agentId: string } }).perspective?.agentId === "player";
      const choice = id === "operation" ? "speak" : id === "recipient" ? player ? "broadcast" : "traveler" :
        id === "speech" ? "create" : id === "timing" ? "default" : id.startsWith("paragraph") ? "grounded" :
        id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered" :
        id.includes("visible") || id.includes("entity") ? "visible" : id.includes("progress") ? "complete" : "none";
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), wire => {
      const context = directCreationContext(wire);
      if (context.scene) {
        proseCalls++;
        if ((context.scene as { reply?: unknown }).reply) return { paragraphs: ["你的问题已经问出，但这次回复生成中断了。可以接着追问尚未得到回答的部分。"] };
        return createText(wire);
      }
      if (!context.playerControlled) {
        if (mode === "service-pause") throw new ExperimentBudgetError("unknown usage requires review", "usage-unresolved");
        return new Response("unavailable", { status: 401 });
      }
      return { attempt: "向周围问价", utterance: "请问铜钥匙多少钱？", manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
    let host = makeHost();
    try {
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "question-before-pause", text: "向周围问问铜钥匙多少钱" });
      for (let i = 0; i < 300; i++) {
        const run = Object.values(database.readInstance(id).document.runs).find(run => run.rootIntents.some(input => input.submissionId === "question-before-pause"));
        if (run && ["failed", "completed"].includes(run.status)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await host.drainNarratives(id);
      const saved = database.readInstance(id).document;
      if (mode === "service-pause") {
        expect(host.instance(id).servicePause).toMatchObject({ code: "usage-unresolved" });
        expect(saved.narratives).toHaveLength(1);
        expect(saved.narratives[0]).toMatchObject({ status: "fallback", attempts: 0,
          segments: [{ sequence: 0, text: expect.stringContaining("你说：“请问铜钥匙多少钱？”") }] });
        expect(saved.actionWindow?.deadlineAt).toBeNull();
        expect(proseCalls).toBe(0);
      } else {
        expect(host.instance(id).servicePause).toBeUndefined();
        expect(saved.narratives).toHaveLength(2);
        expect(saved.narratives.every(beat => beat.status === "complete")).toBe(true);
        expect(saved.narratives[1]!.source).toMatchObject({ reply: { kind: "recovery" },
          priorObservedReceipts: [{ requestRelation: "participant_step", scene: { actor: "你", speech: { utterance: "请问铜钥匙多少钱？" } } }] });
        expect(saved.narratives[1]!.segments[0]!.text).toContain("你的问题已经问出");
        expect(proseCalls).toBe(2);
      }
      expect(saved.state.history.flatMap(step => step.directEvent?.frames ?? []).map(frame => frame.actorId)).toEqual(["player"]);
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
      const calls = f.transport.mock.calls.length;
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      host.instance(id); host.instance(id); await host.drainNarratives(id);
      expect(f.transport).toHaveBeenCalledTimes(calls);
      expect(database.readInstance(id).document.narratives).toEqual(saved.narratives);
      expect(database.readInstance(id).document.state).toEqual(saved.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("persists streamed paragraphs, holds the reply clock, resumes after restart and never regenerates on reads", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-recovery-"));
    const scheduledDelays: number[] = [];
    let paragraphsSaved!: () => void, interrupt!: () => void, narrativeCalls = 0;
    const savedParagraph = new Promise<void>(resolve => { paragraphsSaved = resolve; });
    const interrupted = new Promise<void>(resolve => { interrupt = resolve; });
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
      id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")])),
      wire => {
        const context = directCreationContext(wire);
        expect(context.publishedPrefix).toEqual(["石门上还留着水迹。"]);
        expect(context.repair).toMatchObject({ mode: "continue_published" });
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
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider,
      setTimer: (callback, delay) => { scheduledDelays.push(delay); const timer = setTimeout(callback, delay); timer.unref(); return timer; } });
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
      expect(recovered.actionWindow).toMatchObject({ kind: "decision", deadlineAt: null, status: "open" });
      expect(scheduledDelays.filter(delay => delay > 0)).toEqual([]);
      expect(recovered.state.truth).toEqual(pending.state.truth);
      expect(replaySimulationState(recovered.state)).toEqual(recovered.state);
      const texts = host.instance(id).conversation!.turns.at(-1)!.responses!.map(response => response.text);
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      await host.drainNarratives(id); expect(narrativeCalls).toBe(2);
      expect(host.instance(id).conversation!.turns.at(-1)!.responses!.map(response => response.text)).toEqual(texts);
    } finally { interrupt(); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([
    { unsupported: "一位陌生船长走来。", prefix: ["你清点了随身物资。"] },
    { unsupported: "告示上写着「全部免费带走」。", prefix: ["你清点了随身物资。"] },
    { unsupported: "你转身跑了出去。", prefix: [] },
  ])("repairs unsupported content using only the published prefix: $unsupported", async ({ unsupported, prefix }) => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-grounding-"));
    let calls = 0;
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const paragraphs = (wire.state as { paragraphs?: string[] }).paragraphs;
      const choice = id.startsWith("paragraph") ? id.endsWith("_material") && paragraphs?.[Number(/^paragraph(\d+)/u.exec(id)?.[1])] === unsupported ? "added_content" : "grounded"
        : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none";
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), wire => {
      const context = directCreationContext(wire);
      if (++calls === 1) return { paragraphs: [...prefix, unsupported] };
      expect(context.publishedPrefix).toEqual(prefix);
      expect(context.repair).toMatchObject({ mode: prefix.length ? "continue_published" : "replace_unpublished" });
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
        ...prefix.map((text, sequence) => ({ sequence, text })), { sequence: prefix.length, text: "三枚灵石仍在你身上。" }] });
      expect(saved.narratives[0]!.grounding.flatMap(check => check.choices)).toContain("added_content");
      expect(saved.state.truth.elapsedSeconds).toBe(1);
      expect(Object.keys(saved.state.truth.entities)).toEqual(Object.keys(world.initialState.truth.entities));
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["nested", "semantic-repeat"])("keeps narrative order through harmless format or continuation variation: %s", async mode => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-continuation-"));
    let generations = 0;
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const context = wire.state as { paragraphs?: string[]; alreadyPublished?: string[] };
      const paragraph = context.paragraphs?.[Number(/^paragraph(\d+)/u.exec(id)?.[1])];
      let choice = id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none";
      if (paragraph === "你又转身跑了出去。" && id.endsWith("_agency")) choice = "added_content";
      if (paragraph === "随身的物资已由你点过。" && id.endsWith("_continuity")) {
        expect(context.alreadyPublished).toEqual(["你清点了随身物资。"]); choice = "redundant";
      }
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), wire => {
      const context = directCreationContext(wire);
      const scene = context.scene as { knownWork: unknown[] };
      expect(scene.knownWork).toEqual(Object.values(world.initialState.agents.player!.character.goals).map(goal => ({ description: goal.description, status: goal.status })));
      generations++;
      if (mode === "nested") return { paragraphs: ["你清点了随身物资。", ["三枚灵石仍在你身上。"]] };
      if (generations === 1) return { paragraphs: ["你清点了随身物资。", "你又转身跑了出去。"] };
      expect(context.repair).toMatchObject({ immutablePublishedParagraphs: ["你清点了随身物资。"] });
      return { paragraphs: ["随身的物资已由你点过。", "三枚灵石仍在你身上。"] };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "read-inventory", text: "清点物资" });
      for (let i = 0; i < 200 && !database.readInstance(id).document.narratives.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drainNarratives(id);
      const saved = database.readInstance(id).document;
      expect(saved.narratives[0]).toMatchObject({ status: "complete", attempts: mode === "nested" ? 1 : 2,
        segments: [{ sequence: 0, text: "你清点了随身物资。" }, { sequence: 1, text: "三枚灵石仍在你身上。" }] });
      expect(generations).toBe(mode === "nested" ? 1 : 2);
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
      const calls = f.transport.mock.calls.length;
      host.instance(id); await host.drainNarratives(id); expect(f.transport.mock.calls.length).toBe(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("starts the first paragraph immediately and batches paragraphs completed during its check", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-narrative-batch-"));
    const paragraphs = ["你清点了物资。", "三枚灵石仍在身上。", "门前的地面没有变化。", "守门人仍在门旁。"];
    let started!: () => void, release!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const canFinish = new Promise<void>(resolve => { release = resolve; });
    const batches: number[] = [];
    const f = quietInitialNpcProvider(async wire => {
      const prose = (wire.state as { paragraphs?: string[] }).paragraphs;
      if (prose) { batches.push(prose.length); if (batches.length === 1) { started(); await canFinish; } }
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
        id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" : id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")]));
    }, () => ({ paragraphs }));
    await f.registry.capture();
    const generate = async <T,>(request: StructuredModelRequest<T>) => {
      if (request.schemaName === "SceneNarrativeV1") {
        await request.onOutputText!(JSON.stringify({ paragraphs: paragraphs.slice(0, 1) }));
        await firstStarted;
        for (let length = 2; length <= paragraphs.length; length++) await request.onOutputText!(JSON.stringify({ paragraphs: paragraphs.slice(0, length) }));
        release();
      }
      return f.gateway.generateStructured(request);
    };
    const provider = new Proxy(f.gateway, { get(target, key) {
      if (key === "generateStructured") return generate;
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
    } });
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "batched-prose", text: "清点物资" });
      for (let i = 0; i < 200 && !database.readInstance(id).document.narratives.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
      await host.drainNarratives(id);
      expect(batches).toEqual([1, 3]);
      const saved = database.readInstance(id).document;
      expect(saved.narratives[0]!.segments.map(segment => segment.text)).toEqual(paragraphs);
      expect(saved.narratives[0]!.status).toBe("complete");
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
    } finally { release(); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("holds a rejected player interpretation across host ticks and reconnect until a new submission", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-player-authorization-"));
    const text = "只查看门闩，不报价。";
    let playerReadings = 0;
    const f = quietInitialNpcProvider(wire => {
      const state = wire.state as { perspective?: { agentId: string }; submittedAction?: { rawText: string };
        playerAuthorization?: Record<string, { originalSubmission: { rawText: string } }> };
      if (state.perspective?.agentId === "player") playerReadings++;
      const rejectedInput = state.submittedAction?.rawText === text;
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question,
        id.endsWith("_player_authorization") ? Object.values(state.playerAuthorization ?? {}).some(value => value.originalSubmission.rawText === text) ? "outside_scope" : "authorized"
          : id.startsWith("paragraph") ? "grounded" : id === "operation" ? rejectedInput ? "speak" : "observe"
            : id === "recipient" ? "broadcast" : id === "target" ? "self" : id === "speech" ? "create"
              : id.includes("outcome") ? "succeeded" : id.endsWith("_duration") ? "s1" : "none")]));
    }, wire => directCreationContext(wire).scene ? { paragraphs: ["刚才那一步没有执行，你可以重新说明想做的事。"] }
      : { attempt: "自行报价", utterance: "维护收你三枚灵石。", manner: null });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const options = { repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway };
      const host = new WorldHost(options);
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "outside-scope", text });
      for (let i = 0; i < 200; i++) {
        if (Object.values(database.readInstance(id).document.runs).some(run => run.stopReason === "local-model-task-failed")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await host.drainNarratives(id);
      const failed = database.readInstance(id).document;
      const run = Object.values(failed.runs).find(value => value.rootIntents.some(intent => intent.submissionId === "outside-scope"))!;
      expect(run).toMatchObject({ status: "failed", stopReason: "local-model-task-failed", error: expect.stringContaining("player authorization") });
      expect(failed.state.truth).toEqual(world.initialState.truth);
      expect(failed.state.history.flatMap(step => step.directEvent?.frames ?? [])).toEqual([]);
      expect(readDirectState(failed.state.executionState!, failed.state).intents.player).toMatchObject({ status: "failed", activeSubmission: { rawText: text } });
      expect(playerReadings).toBe(1);
      await expect(host.resumeRun(id, { runId: run.id, generation: run.generation })).rejects.toThrow("cannot be resumed");
      await host.advance(id, { expectedRevision: failed.state.revision, trigger: "realtime" });
      const restarted = new WorldHost(options);
      expect(restarted.instance(id).run).toMatchObject({ status: "awaiting-decision", stopReason: "external-decision-required" });
      await restarted.drainNarratives(id);
      expect(playerReadings).toBe(1);
      expect(database.readInstance(id).document.state).toEqual(failed.state);
      await restarted.submitAction(id, participant.id, { expectedRevision: failed.state.revision, submissionId: "new-authorized-input", text: "查看自己" });
      for (let i = 0; i < 200 && database.readInstance(id).document.state.revision === failed.state.revision; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await restarted.drainNarratives(id);
      const recovered = database.readInstance(id).document.state;
      expect(playerReadings).toBe(2);
      expect(recovered.history.flatMap(step => step.directEvent?.frames ?? [])).toContainEqual(expect.objectContaining({ actorId: "player", kind: "observe", submissionId: "new-authorized-input" }));
      expect(readDirectState(recovered.executionState!, recovered).intents.player?.failure).toBeNull();
      expect(replaySimulationState(recovered)).toEqual(recovered);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("retains a rejected continuation while an already admitted NPC reply finishes after reconnect", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-player-scope-reaction-"));
    let playerReadings = 0;
    const f = quietInitialNpcProvider(wire => {
      const state = wire.state as { perspective?: { agentId: string }; actions?: Array<{ actorId: string; utterance: string | null }> };
      if (state.perspective?.agentId === "player") playerReadings++;
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        const action = state.actions?.[Number(id.split("_")[0]!.slice(1))];
        const value = id.endsWith("_player_authorization") ? action?.utterance === "维修收你三枚灵石。" ? "outside_scope" : "authorized"
          : id.endsWith("_request_progress") ? action?.actorId === "player" ? "continue" : "complete"
            : id.endsWith("_duration") ? action?.actorId === "keeper" ? "s60" : "s1"
              : id.startsWith("progress_") ? "continue" : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "speak" : id === "recipient" ? "broadcast"
                : id === "speech" ? "create" : id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered"
                  : id.includes("visible") ? "visible" : id.includes("fact") || id.includes("status") ? "unchanged" : "none";
        return [id, nativeAnswer(question, value)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) return createText(wire);
      return { attempt: context.playerControlled ? playerReadings === 1 ? "询问检查范围" : "自行报价" : "回复检查范围",
        utterance: context.playerControlled ? playerReadings === 1 ? "要检查哪一处？" : "维修收你三枚灵石。" : "请先检查门闩。", manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    world.initialState.truth.timers["intervening-clock"] = { id: "intervening-clock", description: "Independent deadline",
      createdAtSeconds: 0, dueAtSeconds: 2, status: "scheduled", wakeAgentIds: [],
      causes: [{ kind: "mechanic", id: "direct-world-clock" }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 2 }] };
    world.initialState.truth.timers["second-clock"] = { id: "second-clock", description: "Second independent deadline",
      createdAtSeconds: 0, dueAtSeconds: 3, status: "scheduled", wakeAgentIds: [],
      causes: [{ kind: "mechanic", id: "direct-world-clock" }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 3 }] };
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const options = { repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway };
      const host = new WorldHost(options);
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "inspect-without-quote", text: "先问要检查哪一处，再免费检查，不报价。" });
      for (let i = 0; i < 250; i++) {
        if (Object.values(database.readInstance(id).document.runs).some(run => run.stopReason === "local-model-task-failed")) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await host.drainNarratives(id);
      const failed = database.readInstance(id).document.state;
      expect(playerReadings).toBe(2);
      expect(failed.truth.elapsedSeconds).toBe(3);
      expect(readDirectState(failed.executionState!, failed)).toMatchObject({ intents: { player: { status: "failed" } },
        activities: [expect.objectContaining({ actorId: "keeper", dueAtSeconds: 61 })] });
      const restarted = new WorldHost(options);
      await restarted.advance(id, { expectedRevision: failed.revision, trigger: "realtime" });
      for (let i = 0; i < 250; i++) {
        if (database.readInstance(id).document.state.truth.elapsedSeconds === 61 && restarted.instance(id).run?.status === "completed") break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await restarted.drainNarratives(id);
      const after = database.readInstance(id).document.state;
      expect(after.history.flatMap(step => step.directEvent?.frames ?? []).map(frame => frame.utterance)).toEqual(["要检查哪一处？", "请先检查门闩。"]);
      expect(after.truth.elapsedSeconds).toBe(61);
      expect(playerReadings).toBe(2);
      expect(readDirectState(after.executionState!, after).intents.player).toMatchObject({ status: "failed", activeSubmission: { submissionId: "inspect-without-quote" } });
      await restarted.advance(id, { expectedRevision: after.revision, trigger: "realtime" });
      expect(restarted.instance(id).run).toMatchObject({ status: "awaiting-decision", stopReason: "external-decision-required" });
      expect(database.readInstance(id).document.state).toEqual(after);
      expect(playerReadings).toBe(2);
      expect(replaySimulationState(after)).toEqual(after);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
  it.each([false, true])("preserves committed progress when a player task fails, with a prior wait: %s", async priorWait => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-failure-"));
    const failedText = priorWait ? "等五秒再看。" : "fail-this-request";
    const f = quietInitialNpcProvider(wire => {
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
      if (!priorWait) expect(executionCalls(f.transport.mock.calls)).toHaveLength(3);
      const recovery = failed.narratives.find(beat => beat.source.reply?.kind === "recovery")!;
      expect(recovery.status).toBe("complete");
      expect(recovery.source.priorObservedReceipts).toHaveLength(priorWait ? 1 : 0);
      if (priorWait) expect(recovery.source.priorObservedReceipts![0]).toMatchObject({ requestRelation: "participant_step", scene: { actionKind: "wait", status: "succeeded", action: { durationSeconds: 5 } } });
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
    const f = quietInitialNpcProvider(wire => {
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
      expect(document.narratives[1]!.source.priorObservedReceipts).toEqual(document.narratives[0]!.source.observations.map(observation => ({ ...observation, requestRelation: "participant_step" })));
      expect(new Map(directControlHistory(state)).get(state.history[0]!.revision)!.completedSubmissionIds).not.toContain("find-and-ask");
      expect(state.history.at(-1)!.observations.find(packet => packet.observerId === "player")?.summary).toContain("不接受");
      expect(Object.values(document.runs).find(run => run.rootIntents.some(intent => intent.submissionId === "find-and-ask"))?.status).toBe("completed");
      expect(document.actionWindow?.requiredAgentIds).toContain("player");
      expect(state.truth.quantities).toEqual(world.initialState.truth.quantities);
      expect(f.transport.mock.calls.filter(([, init]) => Object.keys(directDecisionContext(JSON.parse(String(init?.body)))?.questions ?? {}).some(id => id === "operation" || id.endsWith("_outcome")))).toHaveLength(7); expect(replaySimulationState(state)).toEqual(state);
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
  it("admits one Blackmarsh Origin alongside 47 autonomous subjects without a reserved player or advance knowledge", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-blackmarsh-origin-"));
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id,
      nativeAnswer(q, id === "operation" ? "wait" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : "none")])));
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: 17, modelCatalog: f.catalog });
    expect(Object.keys(world.initialState.agents)).toHaveLength(47);
    expect(world.initialState.truth.entities).not.toHaveProperty("player");
    for (const agent of Object.values(world.initialState.agents)) {
      expect(agent.belief.localEntities).not.toHaveProperty("newcomer");
      expect(agent.bindings).not.toHaveProperty("newcomer");
      expect(Object.values(agent.bindings).flatMap(binding => binding.canonicalEntityIds)).not.toContain("player");
    }
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const repository = new MemoryWorldRepository({ [world.id]: world });
      const host = new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: world.participation!.origins[0]!.id,
        displayName: "测试旅人", appearance: "旅人装束。", motivation: "观察周围环境。" } });
      const document = database.readInstance(created.summary.id).document;
      const participant = created.participants[0]!;
      expect(Object.keys(document.state.agents)).toHaveLength(48); expect(f.transport).not.toHaveBeenCalled();
      expect(Object.keys(document.state.agents).filter(id => !world.initialState.agents[id])).toEqual([participant.agentId]);
      expect(document.state.agents[participant.agentId]!.bindings.self!.canonicalEntityIds).toEqual([participant.agentId]);
      expect(JSON.stringify(document.state.agents[participant.agentId]!.belief)).not.toContain("ragnar-ring-identity");
      expect(document.policyBindings[participant.agentId]).toMatchObject({ kind: "external", participantId: participant.id });
      for (const id of Object.keys(world.initialState.agents)) expect(document.state.agents[id]!.bindings).toEqual(world.initialState.agents[id]!.bindings);
      const pinned = repository.loadVersion(document.world.id, document.world.contentHash, document.state.historyBase!.truth.rng.seed, f.catalog);
      const engine = new SimulationEngine(pinned, new DirectWorldAlgorithm(f.gateway), document.state);
      const result = await engine.step(document.policyBindings, { expectedRevision: document.state.revision, trigger: "manual", externalActions: [] });
      const control = readDirectState(result.state.executionState!, result.state);
      expect(Object.values(control.intents).filter(intent => intent.status === "failed")).toEqual([]);
      expect(executionCalls(f.transport.mock.calls)).toHaveLength(47);
      expect(result.modelAudits.every(audit => audit.protocol === "typesafe-systemone" || audit.promptVersion.startsWith("autonomous-action-"))).toBe(true);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("commits natural language and replays its complete decision path, with preflight fallback=%s", async preflightFallback => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-default-"));
    const f = quietInitialNpcProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const values: Record<string, string> = { operation: "observe", target: "self", tool: "none", amount: "unknown", resource: "none", speech: "none", timing: "default", goal: "none" };
      const choice = id.endsWith("_player_authorization") ? "authorized" : id.startsWith("paragraph") ? "grounded" : values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("belief_status") ? "unchanged" : "unknown");
      return [id, nativeAnswer(q, id === "expression" ? 0 : choice)];
    })), createText, preflightFallback ? { maxNativeInputBytes: 100 } : {});
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
    try {
      let host = makeHost();
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
      const id = created.summary.id;
      expect(database.readInstance(id).document).toMatchObject({ schemaVersion: 33, executionAlgorithm: DEFAULT_ALGORITHM_REF,
        state: { schemaVersion: 22, executionState: { data: { kind: "direct-world" } } } });
      expect(f.transport).not.toHaveBeenCalled();
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      expect(f.transport).toHaveBeenCalledTimes(1);
      expect(executionCalls(f.transport.mock.calls)).toHaveLength(0);
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      for (let i = 0; i < 100 && database.readInstance(id).document.state.revision === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      await host.drainNarratives(id);
      expect(database.readInstance(id).document.narratives[0]?.error).toBeNull();
      const saved = database.readInstance(id).document.state;
      expect(saved.revision).toBe(1); expect(saved.truth.elapsedSeconds).toBe(1);
      expect(saved.history[0]!.actions[0]!.rawText).toBe("检查自己的情况");
      expect(host.inspectorStep(id, 1).directRuntime!.actions[0]!.kind).toBe("observe");
      const adjudication = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
        .find(wire => wire?.questions.a0_player_authorization)!;
      const frame = saved.history[0]!.directEvent!.frames[0]!;
      expect(adjudication.state).toMatchObject({ playerAuthorization: { [frame.id]: {
        originalSubmission: { submissionId: "observe-self", rawText: "检查自己的情况" }, completedSteps: [],
      } } });
      expect(saved.history[0]!.directEvent!.decisions.find(use => use.batch.questions.a0_player_authorization)?.result.answers.a0_player_authorization)
        .toMatchObject({ type: "choice", choice: "authorized" });
      expect(replaySimulationState(saved)).toEqual(saved);
      expect(executionCalls(f.transport.mock.calls)).toHaveLength(5);
      const executionId = saved.history[0]!.executionRef!.executionId;
      const rejected = database.executionEvents(executionId).filter(event => event.event === "model.context.rejected");
      expect(rejected.length > 0).toBe(preflightFallback);
      for (const event of rejected) {
        expect(event.correlation?.modelInvocationId).toBeUndefined();
        const invocationId = (event.payload as { modelInvocationId: string }).modelInvocationId;
        expect(database.executionEvents(executionId).some(item => item.event === "model.invocation.started" && item.correlation?.modelInvocationId === invocationId)).toBe(false);
      }
      expect(candidatePartitions(database.executionEvents(executionId))).toMatchObject({
        temporal: { fromSeconds: 0, atSeconds: 1 }, resolution: { rng: saved.truth.rng },
      });
      const replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
      const candidate = (execution: string) => database.executionEvents(execution).find(event => event.event === "execution.candidate.persisted")?.payload;
      expect(candidate(replay.replayExecutionId)).toEqual(candidate(executionId));
      expect(replay.replayStatus).toBe("succeeded"); expect(replay.stateHash).toBe(database.execution(executionId)!.stateHash);
      if (preflightFallback) {
        const events = database.executionEvents(executionId);
        const input = events.find(event => event.event === "step.started")!.payload as {
          state: SimulationState; policyRoster: Parameters<SimulationEngine["step"]>[0]; request: Parameters<SimulationEngine["step"]>[1];
        };
        const checkpointProvider = new DebugCheckpointModelProvider(f.gateway, events, Number.MAX_SAFE_INTEGER);
        const resumed = await new SimulationEngine(world, new DirectWorldAlgorithm(checkpointProvider), input.state)
          .step(input.policyRoster, input.request);
        expect(resumed.committed.directEvent).toEqual(saved.history[0]!.directEvent);
        expect(resumed.state.truth).toEqual(saved.truth);
      }
      expect(executionCalls(f.transport.mock.calls)).toHaveLength(5);
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      expect(host.instance(id).summary.revision).toBe(saved.revision);
      expect(database.readInstance(id).document.state).toEqual(saved);
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      expect(database.readInstance(id).document.state).toEqual(saved); expect(executionCalls(f.transport.mock.calls)).toHaveLength(5);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
