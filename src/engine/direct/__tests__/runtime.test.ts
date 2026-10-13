import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { quantityId } from "../../runtime/runtime-id";
import type { PolicyBinding, WorldAdvanceRequest } from "../../runtime/execution";
import { WorldQuiescentError } from "../../runtime/execution";
import { readDirectState } from "../state";
import { speechSpans } from "../actions";

async function fixture(options: { operation?: string; target?: string; tool?: string; amount?: string; failKeeper?: boolean;
  observationScope?: string; speech?: string; creationEnabled?: boolean; privateGateFact?: boolean; named?: boolean;
  creationResponse?: unknown; introduce?: boolean; outcome?: string; movement?: string; effectExpansion?: boolean; expression?: number } = {}) {
  const f = directTestProvider(wire => {
    if (!wire.questions) return options.creationResponse ?? { attempt: "复核已有证据", utterance: "观察与他人的说法需要分开核对；下一步询问消息来源。" };
    const context = wire.state as { perspective?: { agentId: string }; submittedAction?: { rawText: string } };
    if (options.failKeeper && context.perspective?.agentId === "keeper") return new Response("unavailable", { status: 503 });
    const selection: Record<string, string> = { operation: options.operation ?? "observe", target: options.target ?? "door", recipient: options.target ?? "none", tool: options.tool ?? "none",
      amount: options.amount ?? "n0", resource: "spirit-stone", speech: options.speech ?? "q0", timing: "default", goal: "none",
      observation_scope: options.observationScope ?? "target" };
    selection.reflection = options.speech ?? "none";
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      let value = selection[id] ?? (id.includes("outcome") ? options.outcome ?? "succeeded" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : id.includes("visible") ? "visible" : id.includes("delivery") ? "delivered" : id.includes("fact") ? "unchanged" : "none");
      if (/_entity\d+_name$/u.test(id)) value = options.named ? "named" : "unnamed";
      else if (/_entity\d+$/u.test(id)) value = "visible";
      if (id.endsWith("_world_expansion")) value = options.introduce ? "introduce" : "none";
      if (id === "accept") value = "apply";
      if (id.endsWith("_expression")) value = options.effectExpansion ? "expand" : "existing";
      if (id.endsWith("_movement")) value = options.movement ?? "enter";
      if (q.type === "choice" && !(value in q.criteria)) value = "none" in q.criteria ? "none" : Object.keys(q.criteria)[0]!;
      return [id, nativeAnswer(q, id === "expression" ? options.expression ?? 0 : value)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  const player = world.initialState.agents.player!;
  if (options.privateGateFact) world.initialState.truth.facts["gate-secret"] = { ...world.initialState.truth.facts["gate-lock"]!,
    id: "gate-secret", predicate: "secret", value: { kind: "text", value: "PRIVATE-CODE" }, description: "PRIVATE-CODE", access: { kind: "agents", agentIds: ["keeper"] } };
  for (const [id, canonicalId] of [["door", "gate"], ["guard", "keeper"], ["yard", "courtyard"]]) {
    player.belief.localEntities[id!] = { id: id!, name: world.initialState.truth.entities[canonicalId!]!.name, description: "Seen nearby", status: "observed" };
    player.bindings[id!] = { localEntityId: id!, canonicalEntityIds: [canonicalId!] };
  }
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: options.creationEnabled ?? false });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = { player: { kind: "external", agentId: "player", participantId: "human" },
    keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles } };
  const request = (text: string, revision = 0): WorldAdvanceRequest => ({ expectedRevision: revision, trigger: "participant_action", externalActions: [
    { agentId: "player", submissionId: `submission-${revision}`, rawText: text, goal: text, means: null, targetIds: [] } ] });
  return { ...f, world, algorithm, engine, roster, request };
}

describe("direct world through the actual simulation entry", () => {
  it("separates a shouted action from actual words and delivers open speech to nearby people", async () => {
    const f = await fixture({ operation: "speak", target: "broadcast", speech: "create", creationEnabled: true,
      creationResponse: { attempt: "向周围大喊", utterance: "还有谁？", manner: "提高声音" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("大喊一声还有谁"));
    const frame = result.state.history[0]!.directEvent!.frames[0]!;
    expect(frame).toMatchObject({ kind: "speak", utterance: "还有谁？", proposal: { rawText: "向周围大喊", goal: "大喊一声还有谁" } });
    expect(result.committed.observations.find(o => o.observerId === "keeper")?.scene?.speech?.utterance).toBe("还有谁？");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("combines a requested gesture with exact quoted words in one expression", async () => {
    const f = await fixture({ operation: "speak", target: "guard", speech: "q0", expression: 1, creationEnabled: true,
      creationResponse: { attempt: "向守门人摆手致意并说话", utterance: "我只是问路！", manner: "摆手致意" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('向守门人摆手，说："我只是打个招呼。"'));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ utterance: "我只是打个招呼。", expression: { manner: "摆手致意" } });
    expect(result.committed.observations.find(o => o.observerId === "keeper")?.scene?.speech?.utterance).toBe("我只是打个招呼。");
  });
  it("admits persistent new people with their own cognition and queues them without leaking private motivation", async () => {
    const f = await fixture({ target: "none", observationScope: "surroundings", creationEnabled: true, introduce: true,
      creationResponse: { description: "一个抱着木箱的人来到庭院。", entities: [{ key: "carrier", kind: "person", name: "洛禾",
        label: "抱木箱的人", appearance: "磨白的短外衣，怀里抱着木箱。", placement: "scene",
        character: { persona: "担心欠款，PRIVATE-MOTIVE", voice: "语速慢", goal: "找一份搬运工作" } }], facts: [], events: [] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看看庭院还有什么人"));
    const newAgent = Object.values(result.state.agents).find(agent => !f.world.initialState.agents[agent.id])!;
    expect(newAgent).toBeDefined(); expect(newAgent.character.persona.summary).toContain("PRIVATE-MOTIVE");
    expect(readDirectState(result.state.executionState!, result.state).intents[newAgent.id]).toMatchObject({ status: "ready", wakeReasons: ["world-arrival"] });
    expect(JSON.stringify(result.state.agents.player!.belief)).not.toContain("PRIVATE-MOTIVE");
    expect(result.committed.observations[0]!.scene?.details).toContainEqual({ label: "抱木箱的人", description: "磨白的短外衣，怀里抱着木箱。" });
    expect(result.state.truth.placements[newAgent.entityId]).toBe("courtyard");
    const replay = replaySimulationState(result.state);
    expect(replay).toEqual(result.state); expect(Object.keys(replay.agents)).toHaveLength(3);
    const restored = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(result.state)));
    expect(Object.keys(restored.snapshot.agents)).toHaveLength(3);
  });
  it("approaches an object in its surrounding place rather than entering it", async () => {
    const f = await fixture({ operation: "move", target: "guard", movement: "near" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("走到守门人旁边"));
    expect(result.state.truth.placements.player).toBe(result.state.truth.placements.keeper);
    expect(result.state.truth.placements.player).not.toBe("keeper");
    expect(result.committed.observations.find(o => o.observerId === "player")?.scene).toMatchObject({ actionKind: "move", status: "succeeded" });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("can discover new ordinary content when the initial observation lacks evidence", async () => {
    const f = await fixture({ operation: "observe", observationScope: "surroundings", target: "none", outcome: "unknown", introduce: true, creationEnabled: true,
      creationResponse: { description: "庭院边发现一块无主碎木。", entities: [{ key: "scrap", kind: "object", name: "碎木", label: "一块碎木", appearance: "一块断裂的废弃木片。", placement: "scene" }], facts: [{ subject: "courtyard", predicate: "scrap-discovery", value: "碎木躺在院边。", description: "院边有碎木。" }, { subject: "scrap", predicate: "appearance", value: "碎木", description: "碎木" }], events: [] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("找找庭院里是否有无主碎木"));
    expect(Object.values(result.state.truth.entities).some(e => e.name === "碎木")).toBe(true);
    expect(result.committed.observations.find(o => o.observerId === "player")?.scene?.status).toBe("succeeded");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("does not silently turn an unrepresented player attempt into observation", async () => {
    const f = await fixture({ operation: "unknown", target: "door" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("试着用门框当作杠杆的支点"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "use", preparatoryFor: null });
  });
  it("contains a failed capability creation as one blocked action and keeps the instance replayable", async () => {
    const f = await fixture({ operation: "use", target: "door", effectExpansion: true, creationEnabled: true,
      creationResponse: new Response("unavailable", { status: 503 }) });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("为门框增加一个临时支点"));
    expect(result.committed.outcomes[0]?.status).toBe("blocked");
    expect(result.state.truth.entities).toEqual(f.world.initialState.truth.entities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("preserves exact question and evidence spans as selectable dialogue", () => {
    expect(speechSpans("询问：附近有哪些住宿地点？请说明消息来源。" )).toContain("附近有哪些住宿地点？请说明消息来源。");
    expect(speechSpans("个人值班记录上的校验码为 ORBIT-7。" )).toContain("个人值班记录上的校验码为 ORBIT-7。");
  });
  it("saves initial intentions without any model request", async () => {
    const f = await fixture(); const state = await f.engine.bootstrapAgents();
    expect(f.transport).not.toHaveBeenCalled();
    expect(readDirectState(state.executionState!, state).intents.keeper!.status).toBe("ready");
    expect(replaySimulationState(state)).toEqual(state);
  });
  it("observes a public fact with Jev only and persists the actual observation", async () => {
    const f = await fixture(); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("查看石门"));
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(Object.values(result.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "lock", value: { kind: "text", value: "sealed" } }));
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(result.modelAudits.every(audit => audit.protocol === "typesafe-systemone")).toBe(true);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("discovers a missing recipient before speech and retains the original player request", async () => {
    const f = await fixture({ operation: "speak", target: "none" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("寻找能回答的人，询问附近哪里能住宿"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak", utterance: null });
    const intent = readDirectState(result.state.executionState!, result.state).intents.player!;
    expect(intent.activeSubmission?.submissionId).toBe("submission-0"); expect(intent.status).toBe("ready");
    expect(f.transport).toHaveBeenCalledTimes(2); expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("reports the actor's owned quantities during self inspection", async () => {
    const f = await fixture({ operation: "observe", target: "self" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("检查自己持有的资源"));
    expect(result.committed.observations.find(packet => packet.observerId === "player")?.summary).toContain("3枚灵石");
  });
  it("selects the actor's inventory even when no external target was selected", async () => {
    const f = await fixture({ target: "none", observationScope: "inventory" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("检查自己的资源"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", targetEntityId: "player", observationScope: "inventory" });
    expect(result.committed.observations[0]!.summary).toContain("3枚灵石");
    expect(result.committed.observations[0]!.introductions).toHaveLength(0);
  });
  it("records a created private reflection as inference without world adjudication or delivery", async () => {
    const f = await fixture({ operation: "reflect", speech: "create", creationEnabled: true }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("整理已有证据，拟定下一步问题，但不说出口"));
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(result.committed.observations.map(packet => packet.observerId)).toEqual(["player"]);
    expect(result.committed.observations[0]!.summary).toContain("下一步询问消息来源");
    expect(Object.values(result.state.agents.player!.belief.evidence)).toContainEqual(expect.objectContaining({ kind: "inference", description: expect.stringContaining("下一步询问消息来源") }));
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("does not disclose private truth even when the model selects it as perceptible", async () => {
    const f = await fixture({ privateGateFact: true }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("观察石门"));
    expect(JSON.stringify(result.committed.observations)).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify(result.state.agents.player!.belief)).not.toContain("PRIVATE-CODE");
    expect(result.state.truth.facts["gate-secret"]!.value).toEqual({ kind: "text", value: "PRIVATE-CODE" });
  });
  it("reveals a recognizable public name through the observation channel", async () => {
    const f = await fixture({ target: "none", observationScope: "surroundings", named: true }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看看周围能辨认的标识"));
    expect(result.committed.observations[0]!.summary).toContain("石门");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("moves without requiring the player to specify time or a behavior program", async () => {
    const f = await fixture({ operation: "move", target: "yard" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("走到庭院"));
    expect(result.state.truth.placements.player).toBe("courtyard");
    expect(result.state.history[0]!.directEvent!.frames[0]!.kind).toBe("move");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("transfers resources atomically and replays/restarts without charging twice", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n1" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("给守门人2枚灵石"));
    const player = quantityId(result.state.worldHash, "spirit-stone", "player"), keeper = quantityId(result.state.worldHash, "spirit-stone", "keeper");
    expect(result.state.truth.quantities[player]!.amount).toBe(1); expect(result.state.truth.quantities[keeper]!.amount).toBe(22);
    const restored = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(result.state)));
    expect(restored.snapshot.truth.quantities[player]!.amount).toBe(1);
    expect(replaySimulationState(result.state)).toEqual(result.state); expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("turns resource shortage into a local blocked outcome with no partial debit", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n1" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("给守门人8枚灵石"));
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("delivers literal speech before waking its recipient and keeps failed NPC work local", async () => {
    const f = await fixture({ operation: "speak", target: "guard", failKeeper: true }); await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request('向守门人说：“请问进门多少钱？”'));
    expect(first.committed.observations.find(packet => packet.observerId === "keeper")?.summary).toContain("请问进门多少钱？");
    const second = await f.engine.step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] });
    expect(readDirectState(second.state.executionState!, second.state).intents.keeper!.status).toBe("failed");
    expect(second.state.truth).toEqual(first.state.truth);
    expect(second.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(second.state)).toEqual(second.state);
    const privateRequests = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => wire.state.perspective);
    expect(JSON.stringify(privateRequests)).not.toContain("canonicalEntityIds");
    expect(JSON.stringify(privateRequests)).not.toContain('"truth"');
  });
  it("stops repeated non-progress work until relevant evidence changes", async () => {
    const f = await fixture({ operation: "observe", target: "self" }); await f.engine.bootstrapAgents();
    f.roster.player = { kind: "idle", agentId: "player", reason: "explicit" };
    for (let revision = 0; revision < 3; revision++) await f.engine.step(f.roster, { expectedRevision: revision, trigger: "manual", externalActions: [] });
    const state = f.engine.snapshot, intent = readDirectState(state.executionState!, state).intents.keeper!;
    expect(intent.failure).toBeNull();
    expect(intent.noProgressCount).toBeGreaterThanOrEqual(1); expect(["same-input", "no-progress"]).toContain(intent.wait!.reason);
    const calls = f.transport.mock.calls.length;
    await expect(f.engine.step(f.roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] })).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(state)).toEqual(state);
  });
});
