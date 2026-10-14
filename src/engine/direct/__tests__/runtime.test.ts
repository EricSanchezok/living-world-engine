import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer, directCreationContext, directDecisionContext } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { quantityId } from "../../runtime/runtime-id";
import type { PolicyBinding, WorldAdvanceRequest } from "../../runtime/execution";
import { WorldQuiescentError } from "../../runtime/execution";
import { readDirectState } from "../state";
import { speechSpans, literalNumbers, literalDurations } from "../actions";
import { applyDirectCognition } from "../cognition";
import { privateActionView } from "../views";

async function fixture(options: { operation?: string; target?: string; tool?: string; amount?: string; failKeeper?: boolean;
  observationScope?: string; speech?: string; creationEnabled?: boolean; privateGateFact?: boolean; named?: boolean;
  creationResponse?: unknown; creationResponses?: unknown[]; missingCoverage?: boolean; introduce?: boolean; outcome?: string; movement?: string; effectExpansion?: boolean; expression?: number;
  recipient?: string; resolvedRecipient?: string; searchLocation?: string; transferAuthority?: string; transferExecution?: string;
  reactionProgress?: string; playerProgress?: string; duplicateIdentity?: boolean; timerSeconds?: number; interaction?: string; duration?: string; actorVisible?: boolean;
  readingOverrides?: Record<string, string>; factValues?: Record<string, string> } = {}) {
  let creations = 0;
  const f = directTestProvider(wire => {
    if (!wire.questions) {
      creations++;
      const context = directCreationContext(wire);
      if (options.effectExpansion && context.chosenDirection) return { attempt: context.currentPlayerRequest, utterance: null, manner: null };
      return options.creationResponses?.[creations - 1] ?? options.creationResponse ?? { attempt: "复核已有证据", utterance: "观察与他人的说法需要分开核对；下一步询问消息来源。" };
    }
    const context = wire.state as { perspective?: { agentId: string }; submittedAction?: { rawText: string }; concreteOperation?: string; lastSearch?: unknown };
    if (options.failKeeper && context.perspective?.agentId === "keeper") return new Response("unavailable", { status: 503 });
    const selection: Record<string, string> = { operation: options.operation ?? "observe", target: options.target ?? "door", recipient: context.concreteOperation || context.lastSearch ? options.resolvedRecipient ?? "discover" : options.recipient ?? options.target ?? "none", tool: options.tool ?? "none",
      amount: options.amount ?? "n1", resource: "spirit-stone", speech: options.speech ?? "q0", timing: "default", goal: "none",
      transfer_authority: options.transferAuthority ?? (options.operation === "transfer" ? "give" : "pending"),
      transfer_execution: options.transferExecution ?? "expression",
      interaction: options.interaction ?? "world_action",
      duration: options.duration ?? "default",
      search_location: options.searchLocation ?? "none",
      observation_scope: options.observationScope ?? "target" };
    selection.reflection = options.speech ?? "none";
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      let value = selection[id] ?? (id.includes("outcome") ? options.outcome ?? "succeeded" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : id.includes("visible") ? "visible" : id.includes("delivery") ? "delivered" : id.includes("fact") ? "unchanged" : "none");
      if (/_entity\d+_name$/u.test(id)) value = options.named ? "named" : "unnamed";
      else if (/_entity\d+$/u.test(id)) value = "visible";
      if (id.includes("actor_visibility")) value = options.actorVisible === false ? "hidden" : "visible";
      if (id.endsWith("_world_expansion")) value = options.introduce ? "introduce" : "none";
      if (id.endsWith("_request_progress")) value = options.reactionProgress ?? "complete";
      if (id.startsWith("progress_")) value = options.playerProgress ?? "complete";
      if (id.startsWith("resource_amount_")) value = options.amount ?? "n1";
      if (id === "accept") value = "apply";
      if (id.startsWith("coverage")) value = options.missingCoverage || options.creationResponses && creations === 1 ? "missing" : "complete";
      if (id.startsWith("identity")) value = options.duplicateIdentity && creations === 1 ? "duplicate" : "distinct";
      if (id.endsWith("_expression")) value = options.effectExpansion ? "expand" : "existing";
      if (id.endsWith("_movement")) value = options.movement ?? "enter";
      if (/_fact\d+$/u.test(id)) {
        const instructions = q.instructions as { task?: { data?: { fact?: { predicate: string } } }; data?: { fact?: { predicate: string } } };
        const fact = (instructions.task ?? instructions).data?.fact;
        value = fact && options.factValues?.[fact.predicate] || value;
      }
      if (q.type === "choice" && !(value in q.criteria)) value = "none" in q.criteria ? "none" : Object.keys(q.criteria)[0]!;
      return [id, wire.messages && options.readingOverrides?.[id] ? { type: "choice", choice: options.readingOverrides[id] }
        : nativeAnswer(q, id === "expression" ? options.expression ?? 0 : value)];
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
  if (options.timerSeconds) world.initialState.truth.timers["test-deadline"] = { id: "test-deadline", description: "Independent deadline",
    createdAtSeconds: 0, dueAtSeconds: options.timerSeconds, status: "scheduled", wakeAgentIds: [],
    causes: [{ kind: "mechanic", id: "direct-world-clock" }],
    assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: options.timerSeconds }] };
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
  it("executes a valid reading even if its diagnostic decomposition is omitted", async () => {
    const f = await fixture({ operation: "observe", target: "door", creationEnabled: true,
      creationResponse: { description: "门已清楚可见。", entities: [], facts: [], events: [] } });
    const transport = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (...args) => {
      const response = await transport(...args);
      const body = await response.clone().json();
      if (!body.choices) return response;
      const value = JSON.parse(body.choices[0].message.content);
      delete value.requestAnalysis;
      body.choices[0].message.content = JSON.stringify(value);
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看看门"));
    expect(result.committed.outcomes[0]?.status).toBe("succeeded");
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("updates the actor's existing posture even when a separate object is the action target", async () => {
    const f = await fixture({ operation: "change", target: "door", factValues: { kneeling: "v1" } });
    f.world.initialState.truth.facts["actor-posture"] = { ...f.world.initialState.truth.facts["gate-lock"]!,
      id: "actor-posture", subjectId: f.world.initialState.agents.player!.entityId, predicate: "kneeling",
      value: { kind: "boolean", value: true }, description: "正跪在门前。", access: { kind: "public" } };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("扶着门框站起来"));
    expect(result.state.truth.facts["actor-posture"]?.value).toEqual({ kind: "boolean", value: false });
    expect(Object.values(result.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "kneeling", value: { kind: "boolean", value: false } }));
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retains perceptible existing conditions after failure without revealing private facts", async () => {
    const f = await fixture({ operation: "use", target: "door", outcome: "failed", privateGateFact: true });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("推开这扇封住的门"));
    expect(result.committed.outcomes[0]?.status).toBe("failed");
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    expect(Object.values(result.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "lock", value: { kind: "text", value: "sealed" } }));
    expect(JSON.stringify(result.committed.observations.filter(observation => observation.observerId === "player"))).not.toContain("PRIVATE-CODE");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("supplies public role property vocabulary to reusable capability creation", async () => {
    const f = await fixture({ operation: "use", target: "door", effectExpansion: true, creationEnabled: true, privateGateFact: true,
      creationResponse: { description: "轻敲门板", applicability: "门板可以触及", effectDescription: "在门板上留下敲击痕迹",
        effects: [{ kind: "fact", subject: "target", predicate: "tapped", value: true, description: "门板有敲击痕迹。" }] } });
    await f.engine.bootstrapAgents();
    await f.engine.step(f.roster, f.request("敲一下门板"));
    const creation = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => !wire.questions)
      .map(wire => directCreationContext(wire)).find(context => context.roleProperties);
    expect(creation?.roleProperties).toMatchObject({ target: [{ predicate: "lock", value: { kind: "text", value: "sealed" } }] });
    expect(JSON.stringify(creation?.roleProperties)).not.toContain("PRIVATE-CODE");
  });
  it("projects retained delivered dialogue with local speaker and addressee roles", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", speech: "input", privateGateFact: true });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("请先检查，然后告诉我你实际看到了什么。"));
    const view = privateActionView(result.state, "keeper").state;
    expect(view).toMatchObject({ interactions: [{ relation: "addressed_to_self", operation: "speak",
      utterance: "请先检查，然后告诉我你实际看到了什么。", result: null }] });
    const playerView = privateActionView(result.state, "player").state;
    expect(playerView).toMatchObject({ interactions: [{ relation: "self" }] });
    expect(JSON.stringify(playerView)).not.toContain("PRIVATE-CODE");
    const forgotten = structuredClone(result.state);
    const keeperObservationIds = new Set(forgotten.history.flatMap(step => step.observations)
      .filter(observation => observation.observerId === "keeper").map(observation => observation.id));
    for (const evidence of Object.values(forgotten.agents.keeper!.belief.evidence)) if (evidence.sourceId && keeperObservationIds.has(evidence.sourceId)) {
      delete forgotten.agents.keeper!.belief.evidence[evidence.id];
    }
    expect(privateActionView(forgotten, "keeper").state).toMatchObject({ interactions: [] });
  });
  it("closes an already executed submission without another action or time advance", async () => {
    const options = { operation: "wait", duration: "d0", playerProgress: "continue", interaction: "world_action",
      creationEnabled: true, timerSeconds: 3600, readingOverrides: {} as Record<string, string> };
    const f = await fixture(options);
    f.roster.keeper = { kind: "idle", agentId: "keeper", reason: "explicit" };
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("安静等五秒"));
    expect(first.state.truth.elapsedSeconds).toBe(5);
    expect(readDirectState(first.state.executionState!, first.state).intents.player!.status).toBe("ready");
    options.interaction = "request_complete";
    options.readingOverrides = { operation: "none", target: "unused-invalid-reference" };
    const calls = f.transport.mock.calls.length;
    const second = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "batch", externalActions: [] });
    expect(second.state.truth).toEqual(first.state.truth);
    expect(second.state.history.at(-1)!.directEvent).toMatchObject({ frames: [], events: [], observations: [], presentation: [] });
    expect(readDirectState(second.state.executionState!, second.state)).toMatchObject({
      completedSubmissionIds: ["submission-0"], intents: { player: { status: "waiting", activeSubmission: null, failure: null } },
    });
    expect(f.transport.mock.calls.length - calls).toBe(1);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("does not let completion skip a fresh submission without its own receipts", async () => {
    const f = await fixture({ interaction: "request_complete", creationEnabled: true });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("再看看门"));
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(readDirectState(result.state.executionState!, result.state).intents.player).toMatchObject({
      status: "failed", failure: { message: "Request completion requires a receipt from this submission" },
    });
    expect(readDirectState(result.state.executionState!, result.state).completedSubmissionIds).toEqual([]);
  });
  it("does not append an invented question after changing the input's terminal punctuation", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true,
      creationResponse: { attempt: "纠正刚才提到的范围", utterance: "我问的是门外——那一带是什么地方？", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("我问的是门外。"));
    expect(result.state.history[0]!.directEvent!.frames[0]!.utterance).toBe("我问的是门外。");
    expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.scene?.speech?.utterance).toBe("我问的是门外。");
  });
  it("preserves already worded player dialogue instead of the interpreter's added reply", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", speech: "input", creationEnabled: true,
      creationResponse: { attempt: "询问对方的来意", utterance: "你为什么来这儿？我只是问问，没什么事，也没人让我来。", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("你为什么来这儿？"));
    expect(result.state.history[0]!.directEvent!.frames[0]!.expression?.utterance).toBe("你为什么来这儿？");
    const heard = result.committed.observations.find(packet => packet.observerId === "keeper")!;
    expect(JSON.stringify(heard)).toContain("你为什么来这儿？");
    expect(JSON.stringify(heard)).not.toContain("没人让我来");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("ignores an invalid unused tool reference while still delivering the requested question", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", speech: "input", creationEnabled: true,
      readingOverrides: { tool: "spirit-stone", search_location: "missing-place", observation_scope: "invented-scope" },
      creationResponse: { attempt: "向守门人询问意见", utterance: "你也看看，这样合适吗？", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("你也看看，这样合适吗？"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "speak", toolEntityId: null });
    expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.scene?.speech?.utterance).toBe("你也看看，这样合适吗？");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("does not require a quantity for a physical attempt using no quantified resource", async () => {
    const f = await fixture({ operation: "use", target: "door", creationEnabled: true,
      readingOverrides: { resource: "none", amount: "none" },
      creationResponse: { attempt: "伸手推门", utterance: null, manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("用手推一下门"));
    expect(result.state.history[0]!.directEvent!.frames[0]!.kind).toBe("use");
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("uses ordinary timing when an explicit duration belongs to a different clause", async () => {
    const f = await fixture({ operation: "observe", target: "door", duration: "none", creationEnabled: true,
      readingOverrides: { timing: "none", duration: "none" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("他让我等五秒，我先看看门。"));
    expect(result.state.truth.elapsedSeconds, JSON.stringify(result.state.history.at(-1)?.directEvent?.frames)).toBe(1);
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("keeps the actor's body out of the separately bound tool role", async () => {
    const f = await fixture({ operation: "use", target: "door", tool: "self", creationEnabled: true,
      readingOverrides: { resource: "none" }, creationResponse: { attempt: "用肩膀推门", utterance: null, manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("用肩膀推一下门"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "use", toolEntityId: null });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("ignores malformed auxiliary cognition and an unused observation branch without cancelling a wait", async () => {
    const f = await fixture({ operation: "wait", duration: "d0", creationEnabled: true,
      readingOverrides: { observation_scope: "none", belief_status_0: "support" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("等五秒"));
    expect(result.state.truth.elapsedSeconds).toBe(5);
    expect(result.state.history[0]!.directEvent!.frames[0]!.kind).toBe("wait");
    expect(Object.values(result.state.history[0]!.directEvent!.cognition[0]!.beliefs)).not.toContain("support");
    expect(result.state.agents.player!.belief.claims[Object.keys(f.world.initialState.agents.player!.belief.claims)[0]!]!.stance)
      .toBe(Object.values(f.world.initialState.agents.player!.belief.claims)[0]!.stance);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("still rejects an invalid parameter used by the selected action", async () => {
    const f = await fixture({ operation: "observe", creationEnabled: true, readingOverrides: { observation_scope: "none" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看一下门"));
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(readDirectState(result.state.executionState!, result.state).intents.player).toMatchObject({ status: "failed" });
  });
  it("approaches the current location within it instead of exiting to its parent", async () => {
    const f = await fixture({ operation: "move", target: "yard", movement: "near" });
    const state = f.world.initialState;
    state.truth.entities.district = { ...state.truth.entities.courtyard!, id: "district", name: "外城" };
    state.truth.placements.district = null;
    state.truth.placements.courtyard = "district";
    state.truth.placements.player = "courtyard";
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("在院子附近挪一下"));
    expect(result.state.truth.placements.player).toBe("courtyard");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("explains an already presented referent without speech, NPC work or physical time", async () => {
    const f = await fixture({ interaction: "clarification", target: "guard", timerSeconds: 36_000 });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("你刚才说的人是指哪位？"));
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.observations).toEqual([]);
    expect(result.state.history[0]!.directEvent).toMatchObject({ frames: [], presentation: [{ kind: "clarification", focusLocalEntityId: "guard", requested: "你刚才说的人是指哪位？" }] });
    expect(readDirectState(result.state.executionState!, result.state).completedSubmissionIds).toContain("submission-0");
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("binds an explicit wait duration once and ignores quoted deadlines on a later observation", async () => {
    const options = { operation: "wait", target: "self", duration: "d0", playerProgress: "continue", creationEnabled: true };
    const f = await fixture(options); await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("等半分钟，再看看这里的情况"));
    expect(first.state.truth.elapsedSeconds).toBe(30);
    options.operation = "observe"; options.duration = "default"; options.playerProgress = "complete";
    const second = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "participant_action", externalActions: [] });
    expect(second.state.truth.elapsedSeconds).toBe(31);
    expect(second.state.history.at(-1)!.directEvent!.frames[0]!.durationSeconds).toBe(1);
    const third = await f.engine.step(f.roster, f.request("牌子上说十分钟以后截止，先看一下牌子", second.state.revision));
    expect(third.state.truth.elapsedSeconds, JSON.stringify(third.state.history.at(-1)!.directEvent!.control.intents.player)).toBe(32);
    expect(replaySimulationState(third.state)).toEqual(third.state);
  });
  it.each([false, true])("keeps hearing distinct from seeing a speaker: visible=%s", async actorVisible => {
    const f = await fixture({ operation: "speak", target: "guard", actorVisible, creationEnabled: true, expression: 1,
      creationResponse: { attempt: "说一声", utterance: "还在吗？", manner: "抬手示意" } });
    const keeper = f.world.initialState.agents.keeper!;
    for (const [id, binding] of Object.entries(keeper.bindings)) if (binding.canonicalEntityIds.includes("player")) {
      delete keeper.bindings[id];
    }
    f.world.initialState.truth.facts["player-appearance"] = { ...f.world.initialState.truth.facts["gate-lock"]!, id: "player-appearance",
      subjectId: "player", predicate: "appearance", value: { kind: "text", value: "袖口有一道白线" }, description: "袖口有一道白线", access: { kind: "public" } };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request('向守门人说：“还在吗？”'));
    const heard = result.committed.observations.find(packet => packet.observerId === "keeper")!;
    expect(heard.scene?.speech).toMatchObject({ utterance: "还在吗？", speakerLocalId: expect.any(String) });
    expect(heard.scene?.manner).toBe(actorVisible ? "抬手示意" : null);
    expect(heard.summary.includes("可见举止：抬手示意")).toBe(actorVisible);
    expect(heard.scene?.action).toMatchObject({ addressing: "direct", target: { localEntityId: expect.any(String) } });
    expect(JSON.stringify(heard).includes("袖口有一道白线")).toBe(actorVisible);
    expect(heard.scene?.actor).toBe(actorVisible ? "附近的人" : "一个陌生的声音");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("keeps a heard-only bystander outside an unseen transfer's targets and quantity", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", actorVisible: false, creationEnabled: true,
      expression: 1, creationResponse: { attempt: "交付灵石并招呼一声", utterance: "听见了吗？", manner: null } });
    const state = f.world.initialState;
    state.truth.entities.listener = { ...state.truth.entities.keeper!, id: "listener" };
    state.truth.placements.listener = state.truth.placements.player!;
    state.agents.listener = { ...structuredClone(state.agents.keeper!), id: "listener", entityId: "listener" };
    for (const binding of Object.values(state.agents.listener.bindings)) binding.canonicalEntityIds = binding.canonicalEntityIds.map(id => id === "keeper" ? "listener" : id);
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step({ ...f.roster, listener: { kind: "idle", agentId: "listener", reason: "timeout" } }, f.request("交付一枚灵石，同时问听见了吗"));
    const heard = result.committed.observations.find(packet => packet.observerId === "listener")!;
    expect(heard).toBeDefined();
    expect(heard.scene).toMatchObject({ actionKind: "speak", action: { target: null, resource: null }, speech: { utterance: "听见了吗？" } });
    expect(heard.summary).not.toContain("转移");
    expect(heard.introductions.some(item => item.canonicalEntityId === "keeper")).toBe(false);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retires an idle participant's pending continuation and cannot jump to a distant timer", async () => {
    const f = await fixture({ operation: "move", target: "yard", playerProgress: "continue", timerSeconds: 36_000 });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("走过去再观察"));
    const calls = f.transport.mock.calls.length;
    for (const id of Object.keys(f.roster)) f.roster[id] = { kind: "idle", agentId: id, reason: "timeout" };
    const request = { expectedRevision: first.state.revision, trigger: "participant_action" as const, externalActions: [],
      autonomousUntilSeconds: first.state.truth.elapsedSeconds + 30 };
    const idle = await f.engine.step(f.roster, request);
    expect(idle.state.truth.elapsedSeconds).toBe(first.state.truth.elapsedSeconds);
    expect(readDirectState(idle.state.executionState!, idle.state).intents.player).toMatchObject({ status: "waiting", activeSubmission: null, causeActionId: null });
    await expect(f.engine.step(f.roster, { ...request, expectedRevision: idle.state.revision })).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(idle.state)).toEqual(idle.state);
    const manual = await f.engine.step(f.roster, { expectedRevision: idle.state.revision, trigger: "manual", externalActions: [] });
    expect(manual.state.truth.elapsedSeconds).toBe(36_000);
    expect(manual.state.truth.timers["test-deadline"]!.status).toBe("fired");
    expect(replaySimulationState(manual.state)).toEqual(manual.state);
  });
  it("keeps a nearer admitted deadline and explicit long participant waiting executable", async () => {
    const timed = await fixture({ timerSeconds: 20 }); await timed.engine.bootstrapAgents();
    for (const id of Object.keys(timed.roster)) timed.roster[id] = { kind: "idle", agentId: id, reason: "timeout" };
    const result = await timed.engine.step(timed.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [], autonomousUntilSeconds: 30 });
    expect(result.state.truth.elapsedSeconds).toBe(20);
    expect(result.state.truth.timers["test-deadline"]!.status).toBe("fired");
    const waiting = await fixture({ operation: "wait", target: "self", speech: "none", duration: "d0" }); await waiting.engine.bootstrapAgents();
    const long = await waiting.engine.step(waiting.roster, waiting.request("原地等待3600秒"));
    expect(long.state.truth.elapsedSeconds).toBe(3600);
    expect(replaySimulationState(long.state)).toEqual(long.state);
  });
  it.each(["transfer", "expression"])("resolves contradictory payment direction without treating quoted words as consent: %s", async transferExecution => {
    const f = await fixture({ operation: "speak", target: "guard", transferAuthority: "give", transferExecution,
      amount: "n2", creationEnabled: false });
    await f.engine.bootstrapAgents();
    const text = transferExecution === "transfer" ? "现在实际交给守门人两枚灵石" : '只说：“我打算给你两枚灵石。”';
    const result = await f.engine.step(f.roster, f.request(text));
    expect(result.state.history[0]!.directEvent!.frames[0]!.kind).toBe(transferExecution === "transfer" ? "transfer" : "speak");
    if (transferExecution === "expression") expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    else expect(Object.values(result.state.truth.quantities).find(quantity => quantity.holderId === "player")!.amount).toBe(1);
    const wire = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .find(wire => wire?.questions.transfer_execution)!;
    expect(wire.state).toMatchObject({ currentPlayerRequest: text, authorizedTransfer: { amount: "n2" } });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("uses only the chosen conditional continuation from the existing player interpretation batch", async () => {
    const f = await fixture({ operation: "move", target: "yard", creationEnabled: true, playerProgress: "continue" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("走进院子，然后观察院子里有没有人"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "move", requestContinuation: "continue" });
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.activeSubmission).not.toBeNull();
    const wires = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body)))).filter(Boolean);
    expect(wires[0]!.questions).toHaveProperty("progress_next");
    expect(wires[1]!.questions).not.toHaveProperty("a0_request_progress");
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("supplies an unresolved search to ordinary reference resolution without a forced recipient override", async () => {
    const options = { operation: "speak", recipient: "discover", searchLocation: "door", outcome: "unknown", speech: "q0" };
    const f = await fixture(options); await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("找门内的店主问路"));
    const second = await f.engine.step(f.roster, f.request('问他：“今天营业吗？”', first.state.revision));
    expect(second.state.history.at(-1)!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak", targetEntityId: "gate", utterance: null });
    const resolved = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .filter(wire => wire?.questions.operation).at(-1)!;
    expect(resolved.state).toMatchObject({ submittedAction: { rawText: '问他：“今天营业吗？”' }, recentActions: [{ requested: "找门内的店主问路", preparatoryFor: "speak" }] });
    options.recipient = "guard";
    const corrected = await f.engine.step(f.roster, f.request('不找店主了，问守门人：“今天营业吗？”', second.state.revision));
    expect(corrected.state.history.at(-1)!.directEvent!.frames[0]).toMatchObject({ kind: "speak", targetEntityId: "keeper", utterance: "今天营业吗？" });
    expect(replaySimulationState(corrected.state)).toEqual(corrected.state);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("repairs an actor clone while preserving a genuinely distinct new character", async () => {
    const entity = { key: "worker", kind: "person", name: "旅人", label: "旅人", appearance: "和玩家同样外观的旅人。", placement: "scene",
      character: { persona: "路过", voice: "简短", goal: "休息" } };
    const first = { description: "旅人到来", entities: [entity], facts: [], events: [] };
    const second = { ...first, entities: [{ ...entity, name: "老工人", label: "老工人", appearance: "满头白发的老工人。" }] };
    const f = await fixture({ target: "none", observationScope: "surroundings", creationEnabled: true, introduce: true,
      duplicateIdentity: true, creationResponses: [first, second] });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("找附近能交谈的人"));
    expect(Object.values(result.state.truth.entities).filter(entity => entity.id.startsWith("expansion-")).map(entity => entity.name)).toEqual(["老工人"]);
    const repair = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => !directDecisionContext(wire)).at(-1);
    expect(directCreationContext(repair).repair).toContain("duplicate existing identities");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each([[false, false], [false, true], [true, false]])("repairs undeclared props and characters at most once before admission: missing=%s, canonical=%s", async (missingCoverage, canonical) => {
    const first = { description: "A worker beside a bucket", entities: [{ key: "worker", kind: "person", name: "Worker", label: "Worker",
      appearance: "A worker standing beside a loose bucket.", placement: "scene", character: { persona: "Careful", voice: "Brief", goal: "Finish work" } }], facts: [], events: [] };
    const second = { ...first, entities: [{ key: "bucket", kind: "object", name: "Bucket", label: "Bucket", appearance: "An empty wooden bucket.", placement: "worker" }, ...first.entities] };
    const f = await fixture({ target: "none", observationScope: "surroundings", creationEnabled: true, introduce: true,
      creationResponses: [first, second], missingCoverage });
    if (canonical) first.entities[0]!.placement = f.world.initialState.truth.placements.player!;
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看看附近的工人与可使用的物件"));
    const creations = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => !directDecisionContext(wire));
    expect(creations).toHaveLength(2);
    expect(directCreationContext(creations[1]).previousDraft).toEqual(first);
    expect(directCreationContext(creations[1]).repair).toContain("without an entity entry");
    const admission = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .find(wire => wire?.questions.accept)!;
    expect(admission.state).toHaveProperty("addition.entities", first.entities);
    expect(admission.state).not.toHaveProperty("addition.description");
    expect(admission.state).toHaveProperty("declaredInventory", [{ name: "Worker", label: "Worker", key: "worker", characterRegistered: true }]);
    expect(admission.questions.coverage0!.instructions).toMatchObject({ task: {
      passage: { owner: "Worker", text: first.entities[0]!.appearance },
    } });
    expect(admission.questions.coverage0!.instructions).not.toHaveProperty("task.declaredInventory");
    const entities = Object.values(result.state.truth.entities).filter(entity => entity.id.startsWith("expansion-"));
    expect(entities.map(entity => entity.name).sort()).toEqual(missingCoverage ? [] : ["Bucket", "Worker"]);
    expect(Object.keys(result.state.agents)).toHaveLength(missingCoverage ? 2 : 3);
    if (missingCoverage) {
      expect(result.committed.outcomes[0]!.status).toBe("partial");
      expect(result.committed.observations.some(observation => observation.scene?.details.length)).toBe(true);
    }
    if (!missingCoverage) expect(result.state.truth.placements[entities.find(entity => entity.name === "Bucket")!.id])
      .toBe(entities.find(entity => entity.name === "Worker")!.id);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("binds quantity choice keys to values regardless of unrelated candidate order", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n2", creationEnabled: true });
    await f.engine.bootstrapAgents();
    const text = "截止时间120秒；现在给守门人两颗灵石";
    const result = await f.engine.step(f.roster, f.request(text));
    expect(result.state.history[0]!.directEvent!.frames[0]!.amount).toBe(2);
    const wire = directDecisionContext(JSON.parse(String(f.transport.mock.calls[0]![1]!.body)))!;
    expect(wire.questions.amount).toMatchObject({ criteria: { n2: "2", n120: "120" } });
    expect(wire.state).toMatchObject({ submittedAction: { rawText: text }, currentRequestReceipts: [] });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("keeps expansion proposal summaries out of committed observations", async () => {
    const f = await fixture({ target: "none", observationScope: "surroundings", creationEnabled: true, introduce: true,
      creationResponse: { description: "你已经走到门外并向守门人承诺付款。", entities: [{ key: "notice", kind: "object", name: "旧木牌",
        label: "旧木牌", appearance: "一块字迹褪色的木牌。", placement: "scene" }], facts: [], events: [] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("先看看附近的告示，稍后再决定是否说话"));
    expect(JSON.stringify(result.committed.observations)).not.toContain("承诺付款");
    expect(result.committed.observations[0]!.scene?.details).toContainEqual(expect.objectContaining({ label: "旧木牌", description: "一块字迹褪色的木牌。", localEntityId: expect.any(String) }));
    expect(result.committed.observations.every(observation => !observation.scene?.speech)).toBe(true);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("scopes expansion admission to named continuity matches while retaining the creator's directory", async () => {
    const f = await fixture({ target: "none", observationScope: "surroundings", creationEnabled: true, introduce: true,
      creationResponse: { description: "发现一处凹角", entities: [{ key: "nook", kind: "place", name: "北库", label: "北库墙角",
        appearance: "北库外墙的一处凹角。", placement: "scene" }], facts: [], events: [] } });
    for (let i = 0; i < 100; i++) f.world.initialState.truth.entities[`remote-${i}`] = {
      id: `remote-${i}`, name: `未涉及的远方地点${i}`, kind: "place", description: "远方的地点", lifecycle: "active", createdAtStep: 0,
    };
    f.world.initialState.truth.entities["named-remote"] = { id: "named-remote", name: "北库商行", kind: "place",
      description: "早已存在的商行", lifecycle: "active", createdAtStep: 0 };
    for (const id of Object.keys(f.world.initialState.truth.entities).filter(id => id.startsWith("remote-") || id === "named-remote")) {
      f.world.initialState.truth.placements[id] = null;
    }
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    await engine.step(f.roster, f.request("看看能挡雨的地方"));
    const wires = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const creation = wires.filter(wire => !wire.questions).map(directCreationContext).find(context => context.establishedEntities);
    expect(creation?.establishedEntities).toHaveLength(Object.keys(f.world.initialState.truth.entities).length);
    const admission = wires.map(directDecisionContext).find(wire => wire?.questions.accept)!;
    expect(admission.state).toMatchObject({ establishedEntities: [{ id: "named-remote", name: "北库商行" }],
      localWorld: { entities: expect.arrayContaining([expect.objectContaining({ id: "player" })]) } });
    expect(JSON.stringify(admission.state)).not.toContain("未涉及的远方地点");
    expect(replaySimulationState(engine.snapshot)).toEqual(engine.snapshot);
  });
  it("binds player expression and action in one interpretation while Jev adjudicates the world", async () => {
    const f = await fixture({ operation: "speak", target: "guard", speech: "none", creationEnabled: true,
      creationResponse: { attempt: "向守门人询问", utterance: "请问现在能通行吗？", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("向守门人询问现在能否通行"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "speak", utterance: "请问现在能通行吗？" });
    const uses = result.state.history[0]!.directEvent!.decisions;
    expect(result.state.history[0]!.directEvent!.modelAudits.filter(audit => audit.profileId === "decision-deepseek")).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(uses.filter(use => use.batch.view.kind === "world").flatMap(use => use.result.dispatches.map(dispatch => dispatch.profileId)))
      .toContain("decision-jev");
  });
  it.each([["yard", "courtyard"], ["door", "gate"]])("searches around the known %s without restricting world-defined entity kinds", async (searchLocation, entityId) => {
    const f = await fixture({ operation: "speak", recipient: "discover", searchLocation, speech: "create" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("向庭院里的工人问路"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak",
      targetEntityId: entityId, observationScope: "target", utterance: null });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("realizes a new player physical operation before adjudication even when the expressive-style answer is negative", async () => {
    const f = await fixture({ operation: "use", target: "door", creationEnabled: true, expression: 0,
      creationResponse: { attempt: "按已知步骤转动门上的控制装置，尝试开门", utterance: null, manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("条件满足后尝试打开门"));
    expect(result.state.history[0]!.directEvent!.frames[0]!.expression?.attempt).toBe("按已知步骤转动门上的控制装置，尝试开门");
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
  });
  it("records a physical attempt with no admitted effects without claiming its requested result or repeating it", async () => {
    const f = await fixture({ operation: "use", target: "door" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("用门上的控制装置打开门"));
    expect(result.committed.outcomes[0]).toMatchObject({ status: "partial", summary: expect.stringContaining("尚无可确认的状态变化") });
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    const intent = readDirectState(result.state.executionState!, result.state).intents.player!;
    expect(intent.status).toBe("waiting");
    expect(JSON.stringify(result.state.agents.player!.belief.evidence)).not.toContain("行动已完成");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("gives report creation the latest observed properties without another character's private truth", async () => {
    const options = { operation: "observe", target: "door", privateGateFact: true, creationEnabled: true, speech: "none" };
    const f = await fixture(options); await f.engine.bootstrapAgents();
    const observed = await f.engine.step(f.roster, f.request("查看门的状态"));
    options.operation = "speak"; options.target = "guard"; options.speech = "create";
    await f.engine.step(f.roster, f.request("如实报告刚才观察到的情况", 1));
    const readings = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => !wire.questions)
      .map(directCreationContext).filter(context => context.playerReading);
    const context = (readings.at(-1)!.playerReading as { state: Record<string, unknown> }).state;
    expect((context.currentObservedFacts as unknown[]).length).toBeGreaterThan(0);
    expect(context.currentObservedFacts).toEqual(expect.arrayContaining(Object.values(observed.state.agents.player!.belief.claims).map(claim =>
      expect.objectContaining({ predicate: claim.predicate, value: claim.value, stance: claim.stance }))));
    expect(JSON.stringify(context.currentObservedFacts)).not.toContain("PRIVATE-CODE");
    const choices = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).map(directDecisionContext).filter(wire => wire?.questions.operation);
    expect((choices.at(-1)!.state as Record<string, unknown>).currentObservedFacts).toEqual(context.currentObservedFacts);
    expect((choices.at(-1)!.state as Record<string, unknown>).recentActions).toEqual([expect.objectContaining({ target: "door", requested: "查看门的状态", actionKind: "observe" })]);
    expect(JSON.stringify((choices.at(-1)!.state as Record<string, unknown>).currentObservedFacts)).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify((choices.at(-1)!.state as Record<string, unknown>).recentActions)).not.toContain("canonicalEntityIds");
    expect(replaySimulationState(f.engine.snapshot)).toEqual(f.engine.snapshot);
  });
  it("keeps an NPC's immediate physical follow-through linked to the triggering action", async () => {
    const f = await fixture({ operation: "speak", target: "guard", speech: "create", creationEnabled: true, reactionProgress: "continue",
      creationResponse: { attempt: "准备交付物品", utterance: "现在给你。", manner: null } });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("请交付约定的物品"));
    const second = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "batch", externalActions: [] });
    const control = readDirectState(second.state.executionState!, second.state);
    expect(control.intents.keeper!.failure).toBeNull();
    expect(control.intents.keeper).toMatchObject({ status: "ready", causeActionId: first.state.history[0]!.directEvent!.frames[0]!.id });
    expect(control.intents.keeper!.wakeReasons).toContain("reaction-progress");
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it.each([0, 1])("keeps an ordinary reply free of unselected physical business: expression=%s", async expression => {
    const f = await fixture({ operation: "speak", target: "broadcast", speech: "create", expression, creationEnabled: true,
      creationResponse: { attempt: "抬手指向门边并作答", utterance: "这里可以通行。", manner: "抬手指向门边" } });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("请问这里可以走吗？"));
    const second = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "batch", externalActions: [] });
    const reply = second.state.history.at(-1)!.directEvent!.frames.find(frame => frame.actorId === "keeper")!;
    expect(reply.utterance).toBe("这里可以通行。");
    expect(reply.expression?.manner).toBe(expression ? "抬手指向门边" : null);
    if (!expression) expect(reply.expression?.attempt).toBe("交谈");
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("separates a shouted action from actual words and delivers open speech to nearby people", async () => {
    const f = await fixture({ operation: "speak", target: "broadcast", speech: "input", creationEnabled: true,
      creationResponse: { attempt: "向周围大喊", utterance: "还有谁？", manner: "提高声音" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("大喊一声还有谁"));
    const frame = result.state.history[0]!.directEvent!.frames[0]!;
    expect(frame).toMatchObject({ kind: "speak", utterance: "还有谁？", proposal: { rawText: "向周围大喊", goal: "大喊一声还有谁" } });
    expect(result.committed.observations.find(o => o.observerId === "keeper")?.scene?.speech?.utterance).toBe("还有谁？");
    const reading = directCreationContext(JSON.parse(String(f.transport.mock.calls[0]![1]?.body))).playerReading as { catalog: { speech: Record<string, unknown> } };
    expect(reading.catalog).not.toHaveProperty("speech");
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
  it("delivers an accompanying utterance with a physical action and records it for every actual listener", async () => {
    const f = await fixture({ operation: "change", target: "door", speech: "create", expression: 1, creationEnabled: true,
      creationResponse: { attempt: "让开门前通道并说明还没有开门", utterance: "我还没有开门。", manner: "侧身让开" } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("让开门前通道，并说明还没有开门"));
    for (const owner of ["player", "keeper"]) expect(result.committed.observations.find(o => o.observerId === owner)?.scene?.speech?.utterance).toBe("我还没有开门。");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("does not speak a later quoted sentence during an approach with no utterance", async () => {
    const f = await fixture({ operation: "move", target: "guard", speech: "q0", expression: 1, creationEnabled: true,
      creationResponse: { attempt: "走近守门人", utterance: null, manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('先走近守门人，然后问：“门能开吗？”'));
    expect(result.state.history[0]!.directEvent!.frames[0]!.utterance).toBeNull();
    expect(result.committed.observations.every(o => o.scene?.speech === null)).toBe(true);
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
    expect(result.committed.observations[0]!.scene?.details).toContainEqual(expect.objectContaining({ label: "抱木箱的人", description: "磨白的短外衣，怀里抱着木箱。", localEntityId: expect.any(String) }));
    expect(result.state.truth.placements[newAgent.entityId]).toBe("courtyard");
    const wires = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const creation = wires.find(wire => !directDecisionContext(wire));
    expect(directCreationContext(creation).establishedEntities).toEqual(expect.arrayContaining([expect.objectContaining({ id: "gate" })]));
    expect(wires.map(directDecisionContext).filter(wire => (wire?.state as { perspective?: unknown })?.perspective).every(wire => !(wire!.state as { establishedEntities?: unknown }).establishedEntities)).toBe(true);
    expect(result.state.history[0]!.directEvent!.reads).toHaveProperty("catalog:entities");
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
  it("relocates a repurposed existing tool without creating another copy", async () => {
    const f = await fixture({ operation: "use", target: "yard", tool: "door", effectExpansion: true, creationEnabled: true,
      creationResponse: { description: "Move an existing object into the surrounding scene", applicability: "The object can be moved",
        effectDescription: "The same object changes position", effects: [{ kind: "placement", subject: "tool", destination: "scene" }] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("把已有的物件放到旁边"));
    expect(Object.keys(result.state.truth.entities)).toEqual(Object.keys(f.world.initialState.truth.entities));
    expect(result.state.truth.placements.gate).toBe(result.state.truth.placements.player);
    expect(result.committed.outcomes[0]?.status).toBe("succeeded");
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
  it("allows the exploration creator to leave an established scene unchanged", async () => {
    const f = await fixture({ operation: "observe", observationScope: "surroundings", target: "none", creationEnabled: true,
      creationResponse: { description: "当前场景已足够清楚。", entities: [], facts: [], events: [] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("再看看院子里已经见过的东西"));
    expect(result.committed.outcomes[0]?.status).toBe("succeeded");
    expect(result.state.truth.entities).toEqual(f.world.initialState.truth.entities);
    expect(f.transport).toHaveBeenCalledTimes(3);
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
    const f = await fixture({ operation: "speak", target: "none", recipient: "discover" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("寻找能回答的人，询问附近哪里能住宿"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak", utterance: null });
    const intent = readDirectState(result.state.executionState!, result.state).intents.player!;
    expect(intent.activeSubmission?.submissionId).toBe("submission-0"); expect(intent.status).toBe("ready");
    expect(f.transport).toHaveBeenCalledTimes(2); expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("keeps an explicit quote unspoken while still discovering its intended listener", async () => {
    const f = await fixture({ operation: "speak", target: "none", recipient: "discover", speech: "q0" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('找附近的旅人说：“刚才的事别外传。”'));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak", utterance: null });
    expect(result.committed.observations.every(o => o.scene?.speech === null)).toBe(true);
    expect(result.committed.observations.map(o => o.observerId)).toEqual(["player"]);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("resolves an inconsistent empty speech recipient without leaking to an unintended audience", async () => {
    const f = await fixture({ operation: "speak", recipient: "none", resolvedRecipient: "guard", speech: "q0" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('向守门人说：“请等一下。”'));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "speak", targetEntityId: "keeper", preparatoryFor: null });
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("listens without inventing an utterance or starting another discovery loop", async () => {
    const f = await fixture({ operation: "wait", recipient: "none", speech: "none" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("听完对方的条件，暂时不承诺"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "wait", utterance: null, preparatoryFor: null });
    expect(result.committed.observations[0]!.scene?.attempt).toBe("等候新的消息或条件变化");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("does not pay the player's money when they asked the other person to deliver", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", transferAuthority: "request", speech: "q0" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('请守门人交还灵石，说：“请把东西交给我。”'));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "speak", utterance: "请把东西交给我。" });
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
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
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(result.committed.observations.map(packet => packet.observerId)).toEqual(["player"]);
    expect(result.committed.observations[0]!.summary).toContain("下一步询问消息来源");
    expect(Object.values(result.state.agents.player!.belief.evidence)).toContainEqual(expect.objectContaining({ kind: "inference", description: expect.stringContaining("下一步询问消息来源") }));
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retains original memories without recursively embedding them in every reflection", async () => {
    const f = await fixture({ operation: "reflect", speech: "none" }); await f.engine.bootstrapAgents();
    const initial = f.engine.snapshot.agents.player!.belief.evidence;
    for (let revision = 0; revision < 5; revision++) {
      const result = await f.engine.step(f.roster, f.request("回顾已有记录", revision));
      expect(result.committed.observations[0]!.summary.length).toBeLessThan(100);
      for (const [id, evidence] of Object.entries(initial)) expect(result.state.agents.player!.belief.evidence[id]).toEqual(evidence);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    }
  });
  it("does not add another inference when support leaves an existing belief unchanged", async () => {
    const f = await fixture(); const state = structuredClone(f.world.initialState);
    const claim = Object.values(state.agents.player!.belief.claims)[0]!;
    claim.stance = "believed";
    const before = structuredClone(state.agents.player!.belief.evidence);
    applyDirectCognition(state, [{ agentId: "player", decisionHash: "a".repeat(64), goals: {}, beliefs: { [claim.id]: "supported" } }], 1);
    expect(state.agents.player!.belief.evidence).toEqual(before);
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
    expect(result.committed.observations.find(observation => observation.observerId === "player")!.summary).toContain("你仍在石门前庭范围内。");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it.each(["给守门人2枚灵石", "给守门人两颗灵石"])("transfers the selected amount atomically and replays without charging twice: %s", async text => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n2" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request(text));
    const player = quantityId(result.state.worldHash, "spirit-stone", "player"), keeper = quantityId(result.state.worldHash, "spirit-stone", "keeper");
    expect(result.state.truth.quantities[player]!.amount).toBe(1); expect(result.state.truth.quantities[keeper]!.amount).toBe(22);
    const restored = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(result.state)));
    expect(restored.snapshot.truth.quantities[player]!.amount).toBe(1);
    expect(replaySimulationState(result.state)).toEqual(result.state); expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("extracts complete Chinese numerals regardless of the following classifier", () => {
    expect(literalNumbers("两节电池，十六瓶水，二十五张纸，两百零三根线，三点五升液体"))
      .toEqual([2, 16, 25, 203, 3.5]);
    expect(literalNumbers("一万二千三百四十五；一亿二千万；二〇二六"))
      .toEqual([12345, 120000000, 2026]);
    expect(literalNumbers("两节电池，120秒截止，2个组件")) .toEqual([120, 2]);
  });
  it("extracts exact duration candidates without deciding their conversational role", () => {
    expect(literalDurations("等五秒；半分钟；一分半；1小时30分钟；两小时又十五分钟"))
      .toEqual([{ text: "五秒", seconds: 5 }, { text: "半分钟", seconds: 30 }, { text: "一分半", seconds: 90 },
        { text: "1小时30分钟", seconds: 5400 }, { text: "两小时又十五分钟", seconds: 8100 }]);
    expect(literalDurations("她说截止还剩十分钟，我只等三秒"))
      .toEqual([{ text: "十分钟", seconds: 600 }, { text: "三秒", seconds: 3 }]);
  });
  it("turns resource shortage into a local blocked outcome with no partial debit", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n8" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("给守门人8枚灵石"));
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(result.committed.outcomes[0]!.summary).toContain("不足以交付所尝试的8");
    expect(result.committed.observations[0]!.scene?.action).toMatchObject({ target: { localEntityId: "guard" }, resource: { amount: 8 } });
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
