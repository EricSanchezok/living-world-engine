import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as transaction from "../../runtime/transaction";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer, directCreationContext, directDecisionContext } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { quantityId } from "../../runtime/runtime-id";
import type { PolicyBinding, WorldAdvanceRequest } from "../../runtime/execution";
import { WorldQuiescentError } from "../../runtime/execution";
import { readDirectState, readyIntent } from "../state";
import { chooseAction, speechSpans, literalNumbers, literalDurations } from "../actions";
import { DirectDecisions } from "../decisions";
import { toWorldRuntimeContract } from "../../runtime/world-definition";
import { applyDirectCognition } from "../cognition";
import { privateActionView } from "../views";
import { contentHash } from "../../models/model-audit";
import { CanonicalCommitter } from "../../runtime/canonical-committer";

async function fixture(options: { resourceUnit?: string; openingQuantity?: number; operation?: string; target?: string; tool?: string; amount?: string; failKeeper?: boolean;
  observationScope?: string; speech?: string; creationEnabled?: boolean; privateGateFact?: boolean; named?: boolean; keeperInitiative?: boolean;
  creationResponse?: unknown; creationResponses?: unknown[]; missingCoverage?: boolean; introduce?: boolean; outcome?: string; movement?: string; effectExpansion?: boolean; expression?: number;
  recipient?: string; resolvedRecipient?: string; searchLocation?: string; transferAuthority?: string; transferExecution?: string;
  reactionProgress?: string; playerProgress?: string; duplicateIdentity?: boolean; timerSeconds?: number; timerWakeAgentIds?: string[]; interaction?: string; duration?: string; actorVisible?: boolean; delivery?: boolean;
  playerAuthorization?: "authorized" | "outside_scope" | "unknown"; mannerSupported?: boolean; witnessRelevance?: "reconsider" | "retain";
  worldOutcomes?: Record<string, string>;
  readingOverrides?: Record<string, string>; npcReadings?: unknown[]; factValues?: Record<string, string>; resolvedDuration?: string; resolvedDurations?: Record<string, string>; effectRepresentation?: "existing" | "no_change" | "already" | "expand";
  withMana?: boolean; meterImpacts?: Record<string, string>; inspectedStock?: number; quantityMeasured?: boolean;
  discoverableGateFact?: boolean; discoveryAdmitted?: boolean; discoveryVerdict?: "examined" | "retained" | "hidden" | "unknown";
  multipleExactAliases?: boolean; referenceOnly?: boolean; referenceVisible?: boolean } = {}) {
  let creations = 0;
  let npcReadings = 0;
  let inspectedQuantityId = "";
  const f = directTestProvider(wire => {
    if (!wire.questions) {
      creations++;
      const context = directCreationContext(wire);
      if (options.effectExpansion && context.chosenDirection) return { attempt: context.currentPlayerRequest, utterance: null, manner: null };
      return options.creationResponses?.[creations - 1] ?? options.creationResponse ?? { attempt: "复核已有证据", utterance: "观察与他人的说法需要分开核对；下一步询问消息来源。" };
    }
    const context = wire.state as { perspective?: { agentId: string }; intent?: { wakeReasons: string[] }; submittedAction?: { rawText: string }; concreteOperation?: string; lastSearch?: unknown };
    if (wire.messages && context.perspective?.agentId === "keeper" && options.npcReadings) {
      return options.npcReadings[Math.min(npcReadings++, options.npcReadings.length - 1)];
    }
    const initialWait = context.perspective?.agentId === "keeper" && context.intent?.wakeReasons.includes("initial-decision") && !options.keeperInitiative;
    if (initialWait) return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id,
      nativeAnswer(question, id === "operation" ? "wait" : "none")]));
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
      else if (/_entity\d+$/u.test(id)) {
        const instructions = q.instructions as { task?: { data?: { entityId?: string } }; data?: { entityId?: string } };
        value = options.referenceOnly && (instructions.task ?? instructions).data?.entityId === "hidden-workroom" && !options.referenceVisible ? "hidden" : "visible";
      }
      if (id.includes("actor_visibility")) value = options.actorVisible === false ? "hidden" : "visible";
      if (id.includes("_relevance")) value = options.witnessRelevance ?? "reconsider";
      if (id.includes("delivery") && options.delivery === false) value = "unavailable";
      if (id.endsWith("_world_expansion")) value = options.introduce ? "introduce" : "none";
      if (id.endsWith("_request_progress")) value = options.reactionProgress ?? "complete";
      if (id.endsWith("_player_authorization")) value = options.playerAuthorization ?? "authorized";
      if (id.endsWith("_manner")) value = options.mannerSupported === false ? "unsupported" : "supported";
      if (id.endsWith("_outcome") && options.worldOutcomes) {
        const action = (wire.state as { actions: Array<{ actorId: string }> }).actions[Number(id.split("_")[0]!.slice(1))]!;
        value = options.worldOutcomes[action.actorId] ?? value;
      }
      if (id.startsWith("progress_")) value = options.playerProgress ?? "complete";
      if (id.startsWith("resource_amount_")) value = options.amount ?? "n1";
      if (id === "accept") value = "apply";
      if (id.startsWith("coverage")) value = options.missingCoverage || options.creationResponses && creations === 1 ? "missing" : "complete";
      if (id.startsWith("identity")) value = options.duplicateIdentity && creations === 1 ? "duplicate" : "distinct";
      if (id.endsWith("_expression")) value = options.effectRepresentation ?? (options.effectExpansion ? "expand" : "existing");
      if (id.endsWith("_movement")) value = options.movement ?? "enter";
      if (id.endsWith("_duration")) {
        const action = (wire.state as { actions?: Array<{ actorId: string }> }).actions?.[Number(id.split("_")[0]!.slice(1))];
        value = action && options.resolvedDurations?.[action.actorId] || options.resolvedDuration || "s1";
      }
      if (/_impact\d+$/u.test(id)) {
        const task = (q.instructions as { task: { data: { meterId: string } } }).task;
        value = options.meterImpacts?.[task.data.meterId] ?? "none";
      }
      if (/_impact\d+_magnitude$/u.test(id)) value = "standard";
      if (/_quantity\d+$/u.test(id)) {
        const task = (q.instructions as { task: { data: { quantityId: string } } }).task;
        value = options.quantityMeasured !== false && task.data.quantityId === inspectedQuantityId ? "measured" : "hidden";
      }
      if (/_visible\d+$/u.test(id)) {
        const task = (q.instructions as { task: { data: { factId: string } } }).task;
        if (task.data.factId === "gate-alloy") value = options.discoveryVerdict ?? (options.discoveryAdmitted === false ? "hidden" : "examined");
      }
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
  if (options.target === "self") inspectedQuantityId = quantityId(world.initialState.worldHash, "spirit-stone", "player");
  if (options.resourceUnit) world.initialState.truth.mechanics.quantities["spirit-stone"]!.unit = options.resourceUnit;
  if (options.openingQuantity !== undefined) world.initialState.truth.quantities[quantityId(world.initialState.worldHash, "spirit-stone", "player")]!.amount = options.openingQuantity;
  if (options.inspectedStock !== undefined) {
    world.initialState.truth.mechanics.quantities["sealed-gold"] = { id: "sealed-gold", name: "封存金砂", unit: "袋", productionLawIds: [], consumptionLawIds: [] };
    inspectedQuantityId = quantityId(world.initialState.worldHash, "spirit-stone", "gate");
    for (const quantity of [
      { holderId: "gate", definitionId: "spirit-stone", amount: options.inspectedStock },
      { holderId: "gate", definitionId: "sealed-gold", amount: 29 },
      { holderId: "courtyard", definitionId: "spirit-stone", amount: 293 },
    ]) {
      const id = quantityId(world.initialState.worldHash, quantity.definitionId, quantity.holderId);
      world.initialState.truth.quantities[id] = { ...quantity, id };
    }
  }
  if (options.withMana) {
    world.initialState.truth.mechanics.meters.mana = { id: "mana", name: "Mana", min: 0, max: 20, thresholds: [] };
    world.initialState.truth.mechanics.impactProfiles["spell-cost"] = { id: "spell-cost", name: "Spell cost", meterDefinitionId: "mana",
      direction: "decrease", amounts: { none: 0, minor: 1, standard: 3, major: 5, decisive: 10 } };
    world.initialState.truth.meters["player-mana"] = { id: "player-mana", entityId: "player", definitionId: "mana", current: 10, firedThresholdIds: [] };
  }
  if (options.privateGateFact) world.initialState.truth.facts["gate-secret"] = { ...world.initialState.truth.facts["gate-lock"]!,
    id: "gate-secret", predicate: "secret", value: { kind: "text", value: "PRIVATE-CODE" }, description: "PRIVATE-CODE", access: { kind: "agents", agentIds: ["keeper"] } };
  if (options.discoverableGateFact) world.initialState.truth.facts["gate-alloy"] = { ...world.initialState.truth.facts["gate-lock"]!,
    id: "gate-alloy", predicate: "alloy", value: { kind: "text", value: "copper-tin" }, description: "The tested metal is copper-tin bronze.",
    access: { kind: "discoverable", condition: "A valid assay of the metal reveals its alloy; ordinary sight cannot identify the composition." } };
  for (const [id, canonicalId] of [["door", "gate"], ["guard", "keeper"], ["yard", "courtyard"]]) {
    player.belief.localEntities[id!] = { id: id!, name: world.initialState.truth.entities[canonicalId!]!.name, description: "Seen nearby", status: "observed" };
    player.bindings[id!] = { localEntityId: id!, canonicalEntityIds: [canonicalId!] };
  }
  if (options.referenceOnly) {
    world.initialState.truth.entities["hidden-workroom"] = { ...world.initialState.truth.entities.courtyard!, id: "hidden-workroom",
      name: "PRIVATE-ROOM-NAME", description: "PRIVATE-ROOM-DETAIL", kind: "location" };
    world.initialState.truth.placements["hidden-workroom"] = "courtyard";
    world.initialState.truth.facts["gate-route"] = { ...world.initialState.truth.facts["gate-lock"]!, id: "gate-route",
      predicate: "route-to", value: { kind: "entity", entityId: "hidden-workroom" }, description: "A route leads to another place." };
  }
  if (options.multipleExactAliases) {
    for (const id of ["old-door", "uncertain-door"]) {
      player.belief.localEntities[id] = { id, name: "曾见的门", description: "由自己的经历记得的入口", status: "observed" };
      player.bindings[id] = { localEntityId: id, canonicalEntityIds: id === "old-door" ? ["gate"] : ["gate", "courtyard"] };
    }
  }
  if (options.timerSeconds) world.initialState.truth.timers["test-deadline"] = { id: "test-deadline", description: "Independent deadline",
    createdAtSeconds: 0, dueAtSeconds: options.timerSeconds, status: "scheduled", wakeAgentIds: options.timerWakeAgentIds ?? [],
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
  it("keeps a relation-only reference distinct from visible presence and admits type before a private name", async () => {
    const options = { referenceOnly: true, referenceVisible: false, named: false };
    const f = await fixture(options);
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("Inspect the gate and its route."));
    const binding = Object.values(first.state.agents.player!.bindings).find(item => item.canonicalEntityIds.includes("hidden-workroom"))!;
    expect(binding).toBeDefined();
    const reference = first.state.agents.player!.belief.localEntities[binding.localEntityId]!;
    expect(reference).toMatchObject({ name: "关系所指的对象", status: "reported" });
    expect(JSON.stringify(first.committed.observations.filter(packet => packet.observerId === "player"))).not.toContain("PRIVATE-ROOM");
    options.referenceVisible = true;
    const seen = await f.engine.step(f.roster, f.request("Look at the visible entrance.", first.state.revision));
    expect(seen.state.agents.player!.belief.localEntities[binding.localEntityId]).toMatchObject({ name: "附近的地点", status: "observed" });
    expect(JSON.stringify(seen.committed.observations.filter(packet => packet.observerId === "player"))).not.toContain("PRIVATE-ROOM");
    options.named = true;
    const named = await f.engine.step(f.roster, f.request("Read the room sign.", seen.state.revision));
    expect(named.state.agents.player!.belief.localEntities[binding.localEntityId]!.name).toBe("PRIVATE-ROOM-NAME");
    expect(JSON.stringify(named.committed.observations.filter(packet => packet.observerId === "player"))).not.toContain("PRIVATE-ROOM-DETAIL");
    expect(replaySimulationState(named.state)).toEqual(named.state);
  });

  it("reuses an exact existing alias across repeated observations without merging uncertain identities", async () => {
    const f = await fixture({ operation: "observe", target: "door", multipleExactAliases: true });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("查看这扇门的状态"));
    const next = await f.engine.step(f.roster, f.request("再看一遍这扇门", first.state.revision));
    expect(next.state.agents.player!.bindings["uncertain-door"]!.canonicalEntityIds).toEqual(["gate", "courtyard"]);
    expect(next.state.agents.player!.belief.localEntities["old-door"]).toEqual(first.state.agents.player!.belief.localEntities["old-door"]);
    expect(next.state.history.flatMap(step => step.observations.filter(observation => observation.observerId === "player")
      .flatMap(observation => observation.introductions)).filter(introduction => introduction.canonicalEntityId === "gate")).toEqual([]);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
  const npcReading = (action: Record<string, unknown>) => ({
    understanding: "Resolve the current uncertainty before deciding whether to admit the traveler.",
    interaction: "world_action", urgency: 0.5,
    action: { operation: "speak", target: "none", recipient: "traveler", tool: "none", resource: "none", amount: "unknown",
      timing: "default", goal: "understand-traveler", observation_scope: "target", capability: "none", search_location: "none",
      reflection_duration: "none", attempt: "询问旅人的来意", utterance: "你来这里找谁？", manner: null, literalQuote: "none", ...action },
    cognition: { goal_status_0: "unchanged", goal_status_1: "unchanged" },
  });

  it.each([false, true])("repairs a contradictory autonomous speech as one intention, never a substituted wait: terminal=%s", async terminal => {
    const invalid = npcReading({ recipient: "none" });
    const f = await fixture({ npcReadings: [invalid, terminal ? invalid : npcReading({})] });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step({ ...f.roster, player: { kind: "idle", agentId: "player", reason: "explicit" } },
      { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const control = readDirectState(result.state.executionState!, result.state);
    const audits = result.modelAudits.filter(audit => audit.promptVersion.startsWith("autonomous-action-"));
    expect(audits).toHaveLength(2);
    if (terminal) {
      expect(result.committed.directEvent.frames).toEqual([]);
      expect(control.intents.keeper?.status).toBe("failed");
      expect(result.state.truth).toEqual(f.world.initialState.truth);
    } else {
      expect(control.intents.keeper?.failure).toBeNull();
      expect(result.committed.directEvent.frames).toMatchObject([{ actorId: "keeper", kind: "speak", targetEntityId: "player",
        goalId: "understand-traveler", utterance: "你来这里找谁？", expression: { attempt: "询问旅人的来意" } }]);
      expect(result.committed.observations.find(o => o.observerId === "player")?.scene?.speech?.utterance).toBe("你来这里找谁？");
      expect(control.intents.keeper?.failure).toBeNull();
      expect(result.state.agents.keeper!.character.goals["understand-traveler"]!.status).toBe("active");
    }
    const request = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).find(wire => !wire.questions);
    expect(request).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    const reading = directCreationContext(request).autonomousReading;
    expect(JSON.stringify(reading)).not.toContain("canonicalEntityIds");
    expect(JSON.stringify(reading)).not.toContain('"truth"');
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("continues a goal from observation to dialogue and permits a deliberate wait", async () => {
    const f = await fixture({ npcReadings: [
      npcReading({ operation: "observe", target: "traveler", recipient: "none", attempt: "查看旅人身上是否有来访凭证", utterance: null }),
      npcReading({}),
      npcReading({ operation: "wait", recipient: "none", attempt: "等待旅人回答来意", utterance: null }),
    ] });
    await f.engine.bootstrapAgents();
    const roster: Record<string, PolicyBinding> = { ...f.roster, player: { kind: "idle", agentId: "player", reason: "explicit" } };
    const first = await f.engine.step(roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const second = await f.engine.step(roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const third = await f.engine.step(roster, { expectedRevision: second.state.revision, trigger: "manual", externalActions: [] });
    expect(first.committed.directEvent.frames[0]).toMatchObject({ kind: "observe", goalId: "understand-traveler" });
    expect(second.committed.directEvent.frames[0]).toMatchObject({ kind: "speak", goalId: "understand-traveler" });
    expect(third.committed.directEvent.frames).toEqual([]);
    expect(third.state.truth).toEqual(second.state.truth);
    expect(readDirectState(third.state.executionState!, third.state).intents.keeper).toMatchObject({ status: "waiting", failure: null });
    expect(third.state.agents.keeper!.character.goals["understand-traveler"]!.status).toBe("active");
    const readings = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter(wire => !wire.questions).map(wire => directCreationContext(wire).autonomousReading as { state: { recentActions: unknown[] } });
    expect(readings[1]!.state.recentActions).toContainEqual(expect.objectContaining({ actionKind: "observe", attempted: "查看旅人身上是否有来访凭证" }));
    expect(replaySimulationState(third.state)).toEqual(third.state);
  });

  it.each([[true, "succeeded"], [true, "partial"], [false, "succeeded"], [true, "failed"]] as const)("discovers an existing property only through a completed admitted examination: %s / %s", async (admitted, outcome) => {
    const f = await fixture({ operation: "observe", target: "door", discoverableGateFact: true, discoveryAdmitted: admitted, outcome, privateGateFact: true });
    await f.engine.bootstrapAgents();
    const before = f.engine.snapshot;
    expect(JSON.stringify(privateActionView(before, "player").state)).not.toContain("copper-tin");
    const result = await f.engine.step(f.roster, f.request("以实际取样检验门锁金属的成分，保留检验结果，暂不向旁人报告"));
    const revealed = admitted && ["succeeded", "partial"].includes(outcome);
    expect(JSON.stringify(result.state.agents.player!.belief).includes("copper-tin")).toBe(revealed);
    expect(JSON.stringify(result.state.agents.keeper!.belief)).not.toContain("copper-tin");
    expect(JSON.stringify(result.state.agents.player!.belief)).not.toContain("PRIVATE-CODE");
    expect(result.state.truth.facts).toEqual(before.truth.facts);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    if (revealed) {
      const changed = structuredClone(result.state);
      changed.truth.facts["gate-alloy"]!.value = { kind: "text", value: "copper-zinc" };
      changed.truth.facts["gate-alloy"]!.description = "The metal is now copper-zinc brass.";
      const remembered = JSON.stringify(privateActionView(changed, "player").state);
      expect(remembered).toContain("copper-tin");
      expect(remembered).not.toContain("copper-zinc");
    }
  });
  it.each([[17, true], [0, true], [17, false]] as const)("inspects only admitted target quantities without leaking them to a witness: %s / %s", async (amount, measured) => {
    const f = await fixture({ operation: "observe", target: "door", inspectedStock: amount, quantityMeasured: measured });
    await f.engine.bootstrapAgents();
    const before = f.engine.snapshot;
    const result = await f.engine.step(f.roster, f.request("清点门上陈列的灵石，暂不告诉旁人"));
    const observations = result.committed.observations.filter(packet => packet.observerId === "player").map(packet => packet.summary).join("\n");
    expect(observations.includes(`本次清点石门：${amount}枚灵石`)).toBe(measured);
    expect(observations).not.toContain("29袋封存金砂");
    expect(observations).not.toContain("293枚灵石");
    expect(result.committed.observations.filter(packet => packet.observerId === "keeper").every(packet => !packet.summary.includes("本次清点"))).toBe(true);
    expect(result.state.truth.quantities).toEqual(before.truth.quantities);
    expect(result.state.truth.facts).toEqual(before.truth.facts);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retains an old examination when reporting it instead of refreshing hidden truth", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", speech: "input", discoverableGateFact: true, discoveryVerdict: "retained" });
    const player = f.world.initialState.agents.player!;
    player.belief.evidence["prior-assay"] = { id: "prior-assay", kind: "observation", description: "An earlier assay found copper-zinc brass.", sourceId: null, step: 0 };
    player.belief.claims["prior-alloy"] = { id: "prior-alloy", subjectId: "door", predicate: "alloy", value: { kind: "text", value: "copper-zinc" },
      description: "The earlier examination found brass.", stance: "believed", confidence: 1, evidenceIds: ["prior-assay"] };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const before = engine.snapshot;
    const result = await engine.step(f.roster, f.request("我记得上次检查是黄铜；现在没有重新检验。"));
    const worldRequests = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(wire => wire.questions?.a0_outcome);
    const examination = worldRequests.flatMap(wire => Object.values(wire.questions) as Array<{ instructions: { task: { data?: { factId?: string } } }; criteria: unknown }>)
      .find(question => question.instructions.task.data?.factId === "gate-alloy");
    expect(examination?.criteria).toHaveProperty("retained");
    expect(result.state.truth.facts).toEqual(before.truth.facts);
    expect(result.state.agents.player!.belief.claims["prior-alloy"]).toEqual(before.agents.player!.belief.claims["prior-alloy"]);
    expect(JSON.stringify(result.state.agents.player!.belief)).not.toContain("copper-tin");
    expect(JSON.stringify(result.state.agents.keeper!.belief)).not.toContain("copper-tin");
    expect(Object.values(result.state.agents.player!.belief.claims).filter(claim => claim.predicate === "alloy")).toHaveLength(1);
    expect(result.committed.observations.some(packet => packet.observerId === "keeper" && packet.scene?.speech?.utterance?.includes("没有重新检验"))).toBe(true);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("charges a completed bounded method without inventing a continuing qualitative condition", async () => {
    const f = await fixture({ operation: "use", target: "door", withMana: true, effectRepresentation: "no_change", meterImpacts: { "player-mana": "spell-cost" } });
    await f.engine.bootstrapAgents();
    const before = f.engine.snapshot;
    const result = await f.engine.step(f.roster, f.request("以法力短暂托起物件，然后放回原位并停止施法"));
    expect(result.state.truth.meters["player-mana"]!.current).toBe(7);
    expect(result.state.truth.facts).toEqual(before.truth.facts);
    expect(result.committed.outcomes.find(outcome => outcome.proposalId === result.committed.actions.find(action => action.actorId === "player")!.id)!.status).toBe("succeeded");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["guard", "self"])("binds actor costs and target effects to real meters without double-charging a shared role: %s", async target => {
    const options: NonNullable<Parameters<typeof fixture>[0]> = { operation: "use", target, withMana: true };
    const f = await fixture(options);
    const health = Object.values(f.world.initialState.truth.meters).find(meter => meter.entityId === "keeper" && meter.definitionId === "health")!;
    options.meterImpacts = { "player-mana": "spell-cost", ...(target === "guard" ? { [health.id]: "harm" } : {}) };
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("消耗法力施放法术"));
    expect(result.state.truth.meters["player-mana"]!.current).toBe(7);
    expect(result.state.truth.meters[health.id]!.current).toBe(health.current - (target === "guard" ? 5 : 0));
    expect(result.committed.operations.filter(operation => operation.kind === "adjust_meter" && operation.meterId === "player-mana")).toHaveLength(1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("resolves every world and witness action reference from the unchanged shared action frames", async () => {
    const f = await fixture({ operation: "move", target: "yard" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("走进院子"));
    expect(result.state.truth.placements.player).toBe("courtyard");
    const wires = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))
      .filter(wire => wire.questions?.a0_outcome);
    expect(wires.length).toBeGreaterThan(0);
    for (const wire of wires) {
      const state = wire.state.context;
      expect(state.actions.length).toBeGreaterThan(0);
      expect(state.worldQueryPlan.physicalQuestions).toBe(Object.keys(wire.questions).length);
      expect(state.worldQueryPlan.logicalQuestions).toBeGreaterThan(state.worldQueryPlan.physicalQuestions);
      for (const q of Object.values(wire.questions) as Array<{ instructions: { task: { data: { actionId?: string; action?: unknown; premises?: { actionId: string; action?: unknown } } } } }>) {
        const data = q.instructions.task.data.premises ?? q.instructions.task.data;
        expect(data.action).toBeUndefined();
        expect(state.actions.some((frame: { id: string }) => frame.id === data.actionId)).toBe(true);
      }
    }
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each([[true, true], [false, true], [true, false]])("delivers the current event to a new actor through an admitted channel: heard=%s, admitted=%s", async (delivered, admitted) => {
    const options: Parameters<typeof fixture>[0] = { operation: "speak", recipient: "broadcast", speech: "input", creationEnabled: true,
      introduce: true, missingCoverage: !admitted, delivery: delivered, actorVisible: false, privateGateFact: true, creationResponse: {
        description: "A worker is present nearby.", entities: [{ key: "worker", kind: "person", name: "Worker", label: "Worker",
          appearance: "A worker in a plain coat.", placement: "scene", character: { persona: "Careful", voice: "Brief", goal: "Finish work" } }], facts: [], events: [],
      } };
    const f = await fixture(options);
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("请问这里能歇脚吗？"));
    const worker = Object.values(result.state.agents).find(agent => agent.id.startsWith("expansion-"))!;
    if (!admitted) {
      expect(worker).toBeUndefined();
      expect(result.committed.observations.every(packet => !packet.observerId.startsWith("expansion-"))).toBe(true);
      expect(replaySimulationState(result.state)).toEqual(result.state);
      return;
    }
    expect(worker).toBeDefined();
    const received = result.committed.observations.find(packet => packet.observerId === worker.id);
    expect(received?.scene?.speech?.utterance).toBe(delivered ? "请问这里能歇脚吗？" : undefined);
    if (delivered) {
      expect(received?.scene?.speech?.speaker).toBe("一个陌生的声音");
      expect(JSON.stringify(worker.belief)).not.toContain("PRIVATE-CODE");
      expect(privateActionView(result.state, worker.id).state).toMatchObject({ interactions: [expect.objectContaining({ utterance: "请问这里能歇脚吗？" })] });
    }
    const intent = readDirectState(result.state.executionState!, result.state).intents[worker.id]!;
    expect(intent.causeActionId).toBe(delivered ? result.committed.directEvent.frames[0]!.id : null);
    expect(f.transport.mock.calls.filter(([, init]) => directDecisionContext(JSON.parse(String(init?.body)))?.questions.accept)).toHaveLength(1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    if (delivered) {
      options.introduce = false;
      options.creationResponse = { utterance: "可以在这里歇脚。", manner: null };
      f.roster[worker.id] = { kind: "model", agentId: worker.id, profiles: worker.modelProfiles };
      const reply = await f.engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "participant_action", externalActions: [] });
      expect(reply.committed.directEvent.frames.find(frame => frame.actorId === worker.id)).toMatchObject({ kind: "speak", causeActionId: intent.causeActionId });
      expect(reply.committed.observations.filter(packet => packet.observerId === "player").some(packet => packet.scene?.speech?.utterance === "可以在这里歇脚。")).toBe(true);
      expect(replaySimulationState(reply.state)).toEqual(reply.state);
    }
  });

  it("admits motivated local initiative, shares time and introduces concurrent subjects only once", async () => {
    const f = await fixture({ operation: "observe", target: "self", keeperInitiative: true });
    // Their old mentions have no identity binding; simultaneous perceptions share an alias namespace.
    const source = f.world.initialState;
    for (const agent of Object.values(source.agents)) for (const [id, binding] of Object.entries(agent.bindings)) {
      if (binding.canonicalEntityIds.some(entityId => entityId !== agent.entityId && ["player", "keeper"].includes(entityId))) {
        delete agent.bindings[id];
      }
    }
    f.world.historyBaseHash = historyReplayBaseHash(source);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("检查自己"));
    expect(result.committed.directEvent.frames.map(frame => frame.actorId).sort()).toEqual(["keeper", "player"]);
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(result.committed.directEvent.frames.find(frame => frame.actorId === "keeper")?.causeActionId).toBeNull();
    for (const id of ["keeper", "player"]) {
      const introductions = result.committed.observations.filter(packet => packet.observerId === id).flatMap(packet => packet.introductions);
      expect(new Set(introductions.map(item => item.localEntity.id)).size).toBe(introductions.length);
    }
    const npcWire = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .find(wire => (wire?.state as { perspective?: { agentId: string } })?.perspective?.agentId === "keeper");
    expect(JSON.stringify(npcWire)).not.toContain("canonicalEntityIds");
    expect(JSON.stringify(npcWire)).not.toContain('"truth"');
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each([false, true])("only admits a distant NPC with an actual goal association: %s", async linked => {
    const f = await fixture();
    const state = f.world.initialState;
    state.truth.entities.remote = { ...state.truth.entities.courtyard!, id: "remote", name: "远处" };
    state.truth.placements.remote = null; state.truth.placements.keeper = "remote";
    if (!linked) state.agents.keeper!.character.goals = {};
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("看看门"));
    const wire = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))));
    expect(wire.some(item => (item?.state as { perspective?: { agentId: string } })?.perspective?.agentId === "keeper")).toBe(linked);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("does not expand a district target into every actor associated with its parent city", async () => {
    const f = await fixture({ operation: "move", target: "yard" });
    const state = f.world.initialState;
    state.truth.entities.city = { ...state.truth.entities.courtyard!, id: "city", name: "城" };
    state.truth.entities.palace = { ...state.truth.entities.courtyard!, id: "palace", name: "宫殿" };
    state.truth.placements.city = null; state.truth.placements.courtyard = "city";
    state.truth.placements.palace = "city"; state.truth.placements.keeper = "palace";
    const keeper = state.agents.keeper!;
    keeper.bindings.traveler!.canonicalEntityIds = ["city"];
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("走到院子里"));
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper?.status).toBe("ready");
  });

  it.each([true, false])("lets an adjacent interior hear a call only when adjudication grants its perceptual channel: %s", async delivered => {
    const f = await fixture({ operation: "speak", recipient: "broadcast", speech: "input", delivery: delivered });
    const state = f.world.initialState;
    state.truth.entities.room = { ...state.truth.entities.courtyard!, id: "room", name: "房间" };
    state.truth.placements.room = "courtyard"; state.truth.placements.keeper = "room";
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("有人在吗？"));
    expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.scene?.speech?.utterance).toBe(delivered ? "有人在吗？" : undefined);
    const ownSummary = result.committed.observations.find(packet => packet.observerId === "player")!.summary;
    expect(ownSummary.includes("没有确认有人听见")).toBe(!delivered);
    expect(ownSummary.split("有人在吗？")).toHaveLength(2);
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper?.wakeReasons.includes("observation")).toBe(delivered);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["retain", "reconsider"] as const)("remembers passive events while only waking for relevant ones: %s", async relevance => {
    const f = await fixture({ operation: "change", target: "door", witnessRelevance: relevance });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("轻轻推开石门"));
    const packet = result.committed.observations.find(item => item.observerId === "keeper");
    expect(packet).toBeDefined();
    expect(Object.values(result.state.agents.keeper!.belief.evidence).some(item => item.sourceId === packet!.id)).toBe(true);
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper!.wakeReasons.includes("observation")).toBe(relevance === "reconsider");
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["guard", "broadcast"])("never gates direct speech or a public call as incidental: %s", async recipient => {
    const f = await fixture({ operation: "speak", recipient, speech: "input", witnessRelevance: "retain" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("请帮我打开这扇门。"));
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper!.wakeReasons).toContain("observation");
    expect(result.committed.observations.find(item => item.observerId === "keeper")?.scene?.speech?.utterance).toBe("请帮我打开这扇门。");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("reuses a decision across clock-only changes but honors deadlines, timers and new outcomes", async () => {
    const f = await fixture({ operation: "wait" }); await f.engine.bootstrapAgents();
    const state = structuredClone(f.engine.snapshot);
    const control = readDirectState(state.executionState!, state);
    const decide = () => chooseAction({ state, definition: toWorldRuntimeContract(f.world), control,
      decisions: new DirectDecisions(f.gateway, control, { workloadId: "wake-regression", batchId: `choice-${f.transport.mock.calls.length}`,
        runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }), agentId: "keeper", creationEnabled: false });
    await decide(); const calls = f.transport.mock.calls.length;
    state.truth.elapsedSeconds += 10;
    control.intents.keeper!.wakeReasons = ["dependency-changed"];
    expect((await decide()).frame).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(control.intents.keeper!.dependencies.clock).toBe(contentHash(state.truth.elapsedSeconds));
    for (const reason of ["deadline", "timer:appointment"]) {
      control.intents.keeper!.wakeReasons = [reason];
      await decide();
    }
    expect(f.transport).toHaveBeenCalledTimes(calls + 2);
    control.intents.keeper!.recentOutcomeIds = ["new-result"];
    await decide();
    expect(f.transport).toHaveBeenCalledTimes(calls + 3);
  });

  it("preserves the NPC's explicit observation target instead of substituting inventory", async () => {
    const f = await fixture({ operation: "observe", target: "traveler", observationScope: "target", keeperInitiative: true });
    f.roster.player = { kind: "idle", agentId: "player", reason: "explicit" };
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.committed.directEvent.frames[0]).toMatchObject({ actorId: "keeper", targetEntityId: "player", observationScope: "target" });
    const wire = directDecisionContext(JSON.parse(String(f.transport.mock.calls[0]![1]?.body)))!;
    expect(wire.questions.observation_scope).toMatchObject({ criteria: { target: expect.any(String) } });
    expect((wire.questions.observation_scope as { criteria: object }).criteria).not.toHaveProperty("inventory");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("settles an active participant reply without starting unrelated ready agents", async () => {
    const f = await fixture({ operation: "speak", target: "self", recipient: "broadcast", duration: "d0", resolvedDuration: "s60",
      keeperInitiative: true, creationEnabled: true, creationResponse: { utterance: "听见了，我忙完就答复。", manner: null },
      npcReadings: [
        npcReading({ operation: "observe", target: "self", recipient: "none", goal: "none", attempt: "检查随身的值守物品", utterance: null }),
        npcReading({ goal: "none", utterance: "现在忙完了，你有什么问题？" }),
      ] });
    const source = f.world.initialState;
    source.truth.entities.remote = { ...source.truth.entities.courtyard!, id: "remote", name: "远处" };
    source.truth.entities.stranger = { ...source.truth.entities.keeper!, id: "stranger", name: "远处的人" };
    source.truth.placements.remote = null;
    source.truth.placements.stranger = "remote";
    const stranger = structuredClone(source.agents.keeper!);
    stranger.id = "stranger"; stranger.entityId = "stranger";
    stranger.bindings.self!.canonicalEntityIds = ["stranger"];
    stranger.character.goals = {};
    source.agents.stranger = stranger;
    f.roster.stranger = { kind: "model", agentId: "stranger", profiles: stranger.modelProfiles };
    f.world.historyBaseHash = historyReplayBaseHash(source);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, f.request('用十秒说：“你好，能回答吗？”'));
    expect(first.state.truth.elapsedSeconds).toBe(10);
    const playerFrame = first.committed.directEvent.frames.find(frame => frame.actorId === "player")!;
    const busy = readDirectState(first.state.executionState!, first.state);
    expect(busy.intents.keeper).toMatchObject({ status: "active", causeActionId: null, pendingCauseActionIds: [playerFrame.id] });
    expect(busy.activities.find(frame => frame.actorId === "keeper")).toMatchObject({ kind: "observe", causeActionId: null });
    expect(busy.intents.player!.activeSubmission).toBeNull();
    const calls = f.transport.mock.calls.length;
    const second = await engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "participant_action", externalActions: [] });
    expect(second.state.truth.elapsedSeconds).toBe(60);
    const continued = f.transport.mock.calls.slice(calls).map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))));
    expect(continued.some(wire => (wire?.state as { perspective?: unknown })?.perspective)).toBe(false);
    expect(second.committed.directEvent.frames.some(frame => frame.actorId === "stranger")).toBe(false);
    expect(readDirectState(second.state.executionState!, second.state).intents.stranger!.status).toBe("ready");
    expect(readDirectState(second.state.executionState!, second.state).intents.keeper).toMatchObject({ status: "ready", causeActionId: playerFrame.id, pendingCauseActionIds: [] });
    const third = await engine.step(f.roster, { expectedRevision: second.state.revision, trigger: "participant_action", externalActions: [] });
    expect(third.committed.directEvent.frames.find(frame => frame.actorId === "keeper")).toMatchObject({ kind: "speak", causeActionId: playerFrame.id });
    expect(replaySimulationState(third.state)).toEqual(third.state);
  });

  it("settles a long player activity without launching unrelated ready NPCs at later boundaries", async () => {
    const f = await fixture({ operation: "wait", duration: "d0", timerSeconds: 2 });
    const state = f.world.initialState;
    state.truth.entities.remote = { ...state.truth.entities.courtyard!, id: "remote", name: "远处" };
    state.truth.placements.remote = null; state.truth.placements.keeper = "remote";
    state.agents.keeper!.character.goals = {};
    f.world.historyBaseHash = historyReplayBaseHash(state);
    const engine = new SimulationEngine(f.world, f.algorithm); await engine.bootstrapAgents();
    const first = await engine.step(f.roster, f.request("等候七秒"));
    expect(first.state.truth.elapsedSeconds).toBe(2);
    const calls = f.transport.mock.calls.length;
    const second = await engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "participant_action", externalActions: [] });
    expect(second.state.truth.elapsedSeconds).toBe(7);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(readDirectState(second.state.executionState!, second.state).intents.keeper?.status).toBe("ready");
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });

  it.each(["observe", "speak", "transfer"])("adjudicates unspecified %s time instead of committing the minimum", async operation => {
    const f = await fixture({ operation, target: "guard", recipient: "guard", speech: "input", resolvedDuration: "s60" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("请介绍一下这里的情况。"));
    const frame = result.committed.directEvent.frames[0]!;
    expect(frame.durationSeconds).toBe(60);
    expect(result.state.truth.elapsedSeconds).toBe(60);
    const worldWire = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).find(wire => wire.questions?.a0_duration);
    expect(worldWire.questions.a0_duration.criteria).not.toHaveProperty("planned");
    expect(worldWire.state.context.actions[0]).toMatchObject({ durationSeconds: 0, dueAtSeconds: null });
    expect(worldWire.state.context.temporalCalibrations).toEqual(f.world.initialState.truth.mechanics.temporalCalibrations);
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("keeps explicit action-bound time authoritative over a different model scale", async () => {
    const f = await fixture({ operation: "wait", duration: "d0", resolvedDuration: "s60" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("等候七秒。"));
    expect(result.state.truth.elapsedSeconds).toBe(7);
    expect(result.committed.directEvent.frames[0]).toMatchObject({ durationSource: "explicit", durationSeconds: 7 });
    const wires = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(wires.some(wire => wire.questions?.a0_duration)).toBe(false);
  });

  it("makes ordinary movement disclose perceptible surroundings without sharing the actor's incidental view", async () => {
    const f = await fixture({ operation: "move", target: "yard", named: true });
    const world = f.world.initialState;
    world.truth.entities.notice = { id: "notice", kind: "object", name: "布告", description: "院内的布告", lifecycle: "active", createdAtStep: 0 };
    world.truth.placements.notice = "courtyard";
    world.truth.facts["notice-detail"] = { id: "notice-detail", subjectId: "notice", predicate: "writing", value: { kind: "text", value: "今日开放" }, description: "今日开放", access: { kind: "public" }, provenance: world.truth.facts["gate-lock"]!.provenance };
    f.world.historyBaseHash = historyReplayBaseHash(world);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("走进院子"));
    const own = result.committed.observations.find(packet => packet.observerId === "player")!;
    expect(own.introductions.some(intro => intro.canonicalEntityId === "notice")).toBe(true);
    expect(own.summary).toContain("今日开放");
    for (const packet of result.committed.observations.filter(packet => packet.observerId !== "player")) {
      expect(packet.introductions.some(intro => intro.canonicalEntityId === "notice")).toBe(false);
    }
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("prepares native events without applying them and rejects a changed frozen event at the canonical boundary", async () => {
    const f = await fixture({ operation: "move", target: "yard" });
    const source = await f.engine.bootstrapAgents();
    const request = f.request("走到院子里");
    const preparation = await f.engine.prepareStep(f.roster, request);
    expect(preparation.kind).toBe("direct");
    expect(preparation).not.toHaveProperty("onsetPerception");
    expect(preparation).not.toHaveProperty("executionState");
    const input = { definition: f.world, state: source, policyRoster: f.roster, request, decisionEligibleAgentIds: ["player"] };
    const before = contentHash(source);
    const apply = vi.spyOn(transaction, "applyWorldDeltaOperation");
    const candidate = await f.algorithm.completeStep(input, preparation, []);
    expect(apply).not.toHaveBeenCalled();
    expect(contentHash(source)).toBe(before);
    expect(candidate).not.toHaveProperty("resolution");
    const changed = structuredClone(candidate);
    changed.record.atSeconds += 1;
    const committer = new CanonicalCommitter();
    expect(() => committer.step(source, changed, f.roster, 300, { definition: f.world, preparation }))
      .toThrow("differs from frozen preparation");
    expect(contentHash(source)).toBe(before);
    const result = await f.engine.completePreparedStep(f.roster, request, preparation, []);
    expect(apply).toHaveBeenCalledTimes(preparation.record.operations.length);
    apply.mockRestore();
    expect(result.state.revision).toBe(source.revision + 1);
    expect(result.committed).not.toHaveProperty("executionState");
    expect(result.committed).not.toHaveProperty("resolutionPlans");
    expect(result.committed.directEvent).not.toHaveProperty("control");
    expect(result.committed.directEvent).not.toHaveProperty("outcomes");
    expect(() => committer.step(source, { ...candidate, resolution: {} } as typeof candidate, f.roster, 300, { definition: f.world, preparation }))
      .toThrow("Direct candidate has unexpected");
    const corrupt = structuredClone(result.state);
    corrupt.history[0]!.directEvent.controlDelta.baseHash = "0".repeat(64);
    expect(() => replaySimulationState(corrupt)).toThrow();
    const control = readDirectState(result.state.executionState!, result.state);
    expect(Object.values(control.cache).every(saved => !("audits" in saved))).toBe(true);

    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["use", "change"])("realizes an NPC's concrete %s method independently of optional manner", async operation => {
    const options: Parameters<typeof fixture>[0] = { operation: "speak", recipient: "guard", speech: "input", creationEnabled: true,
      expression: 0, creationResponse: { utterance: "请让一下通道。", manner: null } };
    const f = await fixture(options);
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("请让一下通道。"));
    options.operation = operation; options.target = "self";
    options.creationResponse = { attempt: "侧身让出眼前的通道", utterance: null, manner: null };
    const result = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const frame = result.committed.directEvent.frames.find(frame => frame.actorId === "keeper")!;
    expect(frame).toMatchObject({ kind: operation, targetEntityId: "keeper", expression: { attempt: "侧身让出眼前的通道", manner: null },
      proposal: { rawText: "侧身让出眼前的通道" } });
    const requests = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    const expressions = requests.filter(wire => !wire.questions).map(directCreationContext)
      .filter(context => (context.autonomousReading as { state: { perspective: { agentId: string } } } | undefined)?.state.perspective.agentId === "keeper");
    expect(expressions).toHaveLength(2);
    expect(expressions[1]).toHaveProperty("autonomousReading.catalog.target.self");
    expect(requests.some(wire => wire.questions?.a0_outcome && JSON.stringify(wire.state).includes("侧身让出眼前的通道"))).toBe(true);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each([undefined, "   "])("rejects an unexpressed NPC physical method without committing an empty action: %s", async attempt => {
    const options: Parameters<typeof fixture>[0] = { operation: "speak", recipient: "guard", speech: "input", creationEnabled: true,
      creationResponse: { utterance: "请让一下通道。", manner: null } };
    const f = await fixture(options);
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("请让一下通道。"));
    options.operation = "use"; options.target = "self";
    options.creationResponse = { attempt, utterance: null, manner: null };
    const result = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(result.committed.directEvent.frames).toHaveLength(0);
    expect(result.state.truth).toEqual(first.state.truth);
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper?.status).toBe("failed");
    expect(result.committed.directEvent.modelAudits.filter(audit => audit.promptVersion.startsWith("autonomous-action-"))).toHaveLength(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["repaired", "invalid-again", "transport"])("bounds NPC expression recovery and retains completed attempts: %s", async mode => {
    const f = await fixture({ operation: "speak", recipient: "broadcast", creationEnabled: true,
      creationResponse: { attempt: "回答旅人", utterance: "听见了，我在这里。", manner: null, recipientLocalId: "traveler" } });
    const transport = f.transport.getMockImplementation()!;
    let expressions = 0;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const context = wire.questions ? null : directCreationContext(wire);
      const npc = Boolean(context?.autonomousReading && !(context.autonomousReading as { state: { intent: { wakeReasons: string[] } } }).state.intent.wakeReasons.includes("initial-decision"));
      if (npc) {
        expressions++;
        expect((context!.autonomousReading as { catalog: unknown }).catalog).toMatchObject({ recipient: { traveler: { name: "旅人" } } });
        if (expressions === 2) expect(context!.repair).toHaveProperty("issues");
        if (mode === "transport") return new Response("unavailable", { status: 401 });
      }
      const response = await transport(...args);
      if (!npc || expressions > 1 && mode === "repaired") return response;
      const body = await response.clone().json();
      body.choices[0].message.content = expressions === 1 ? "" : "{}";
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request('向周围说：“有人能回答吗？”'));
    const result = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(expressions).toBe(mode === "transport" ? 1 : 2);
    const event = result.state.history.at(-1)!.directEvent!;
    const audits = event.modelAudits.filter(audit => audit.promptVersion.startsWith("autonomous-action-"));
    // Transport failures have no completion audit; their actual send is retained
    // by the gateway's transport evidence, not a fabricated model completion.
    expect(audits).toHaveLength(mode === "transport" ? 0 : expressions);
    expect(new Set(audits.flatMap(audit => audit.invocations.map(invocation => invocation.id))).size).toBe(audits.length);
    if (mode === "repaired") {
      expect(event.frames).toMatchObject([{ actorId: "keeper", targetEntityId: "player", utterance: "听见了，我在这里。" }]);
      expect(result.committed.observations.find(observation => observation.observerId === "player")?.scene?.action?.addressing).toBe("direct");
    } else {
      expect(event.frames).toHaveLength(0);
      expect(readDirectState(result.state.executionState!, result.state).intents.keeper?.status).toBe("failed");
      expect(result.state.truth).toEqual(first.state.truth);
    }
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("selects the literal input independently of an unauthorized generated speech expansion", async () => {
    const words = "刚才那个问题，麻烦继续说。";
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true,
      creationResponse: { attempt: "请对方继续", utterance: "我先付钱，再替你把门修好。", manner: null } });
    const transport = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const response = await transport(...args);
      if (wire.questions || !directCreationContext(wire).playerReading) return response;
      const body = await response.clone().json(), value = JSON.parse(body.choices[0].message.content);
      value.action.literalQuote = "input";
      body.choices[0].message.content = JSON.stringify(value);
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request(words));
    expect(result.state.history[0]!.directEvent!.frames[0]!.utterance).toBe(words);
    expect(result.committed.observations.find(observation => observation.observerId === "keeper")?.scene?.speech?.utterance).toBe(words);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["outside_scope", "unknown"] as const)("rejects an unadmitted player quote as a service failure, without speaking or advancing the world: %s", async playerAuthorization => {
    const text = "我免费检查门闩，只检查，不报价。";
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true, playerAuthorization,
      creationResponse: { attempt: "回答检查结果并报价", utterance: "一定是门闩坏了，维修收你三枚灵石。", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request(text));
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(result.committed.events).toEqual([]);
    expect(result.committed.outcomes).toEqual([]);
    expect(result.committed.observations).toEqual([]);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    const control = readDirectState(result.state.executionState!, result.state);
    expect(control.intents.player).toMatchObject({ status: "failed", activityId: null,
      activeSubmission: { rawText: text }, failure: { recoverable: true, message: expect.stringContaining("player authorization") } });
    expect(control.activities).toEqual([]);
    expect(control.completedSubmissionIds).toEqual([]);
    const batches = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .filter(wire => wire && "actions" in (wire.state as object));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.questions).toHaveProperty("a0_outcome");
    expect(batches[0]!.questions).toHaveProperty("a0_player_authorization");
    const context = batches[0]!.state as { actions: Array<{ id: string }>; playerAuthorization: Record<string, unknown> };
    expect(context.playerAuthorization[context.actions[0]!.id]).toMatchObject({ originalSubmission: { rawText: text }, completedSteps: [] });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("rejects only the unauthorized player candidate while admitting a same-batch NPC question", async () => {
    const question = "检查的结果怎么样？维护收多少钱？";
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true, playerAuthorization: "outside_scope",
      keeperInitiative: true, npcReadings: [npcReading({ utterance: question })],
      creationResponse: { attempt: "自行报价", utterance: "维修收你三枚灵石。", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("我先免费检查门闩。"));
    expect(result.committed.directEvent.frames).toMatchObject([{ actorId: "keeper", utterance: question }]);
    expect(result.committed.events).toHaveLength(1);
    expect(result.committed.outcomes).toHaveLength(1);
    expect(result.committed.observations.every(observation => observation.scene?.speech?.utterance !== "维修收你三枚灵石。")).toBe(true);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(readDirectState(result.state.executionState!, result.state).intents.player).toMatchObject({ status: "failed", activityId: null });
    const batches = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .filter(wire => wire && "actions" in (wire.state as object));
    expect(batches).toHaveLength(1);
    expect(Object.keys(batches[0]!.questions).filter(key => key.endsWith("_player_authorization"))).toHaveLength(1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const calls = f.transport.mock.calls.length;
    await expect(f.engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "realtime", externalActions: [] }))
      .rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(f.engine.snapshot).toEqual(result.state);
  });
  it.each(["later-observation", "timer"] as const)("does not revive a failed player submission from a subsequent world event: %s", async event => {
    const question = "你希望检查哪一处？";
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true, playerAuthorization: "outside_scope",
      timerSeconds: 1, timerWakeAgentIds: event === "timer" ? ["player"] : [], resolvedDuration: "s60",
      keeperInitiative: event === "later-observation", npcReadings: event === "later-observation" ? [npcReading({ utterance: question })] : undefined,
      creationResponse: { attempt: "自行报价", utterance: "维修收你三枚灵石。", manner: null } });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("我先免费检查门闩。"));
    expect(first.committed.directEvent.frames).toEqual([]);
    expect(readDirectState(first.state.executionState!, first.state).intents.player?.status).toBe("failed");
    const calls = f.transport.mock.calls.length;
    const later = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "realtime", externalActions: [] });
    expect(later.state.truth.elapsedSeconds).toBe(event === "later-observation" ? 60 : 1);
    expect(later.committed.directEvent.frames).toEqual(event === "later-observation" ? [expect.objectContaining({ actorId: "keeper", utterance: question })] : []);
    expect(readDirectState(later.state.executionState!, later.state).intents.player).toMatchObject({ status: "failed", activeSubmission: { submissionId: "submission-0" } });
    expect(f.transport).toHaveBeenCalledTimes(calls);
    await expect(f.engine.step(f.roster, { expectedRevision: later.state.revision, trigger: "realtime", externalActions: [] })).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(later.state)).toEqual(later.state);
  });
  it("releases a rejected human submission before the character chooses autonomously", async () => {
    const options: Parameters<typeof fixture>[0] = { operation: "speak", recipient: "guard", creationEnabled: true,
      playerAuthorization: "outside_scope", timerSeconds: 1, timerWakeAgentIds: ["player"],
      creationResponse: { attempt: "自行报价", utterance: "维修收你三枚灵石。", manner: null } };
    const f = await fixture(options);
    await f.engine.bootstrapAgents();
    const failed = await f.engine.step(f.roster, f.request("我先免费检查门闩。"));
    const calls = f.transport.mock.calls.length;
    options.operation = "observe"; options.target = "door";
    const roster: Record<string, PolicyBinding> = { ...f.roster,
      player: { kind: "model", agentId: "player", profiles: f.world.initialState.agents.player!.modelProfiles, resumeFromRevision: 0 } };
    const released = await f.engine.step(roster, { expectedRevision: failed.state.revision, trigger: "realtime", externalActions: [] });
    expect(released.committed.directEvent.frames).toMatchObject([{ actorId: "player", kind: "observe", submissionId: null }]);
    expect(readDirectState(released.state.executionState!, released.state).intents.player).toMatchObject({ activeSubmission: null, failure: null });
    const readings = f.transport.mock.calls.slice(calls).map(([, init]) => JSON.parse(String(init?.body)))
      .filter(wire => !wire.questions).map(directCreationContext);
    expect(readings.some(context => context.autonomousReading)).toBe(true);
    expect(readings.some(context => context.playerReading)).toBe(false);
    expect(replaySimulationState(released.state)).toEqual(released.state);
  });
  it.each([false, true])("preserves an admitted physical activity when its player releases control, with changed evidence: %s", async changedEvidence => {
    const f = await fixture({ operation: "observe", target: "door", timerSeconds: 1, resolvedDuration: "s60",
      resolvedDurations: { keeper: "s1" }, keeperInitiative: changedEvidence,
      npcReadings: changedEvidence ? [npcReading({ utterance: "门闩就在这里。" })] : undefined });
    await f.engine.bootstrapAgents();
    const running = await f.engine.step(f.roster, f.request("查看门闩。"));
    expect(running.committed.directEvent.frames).toEqual(changedEvidence ? [expect.objectContaining({ actorId: "keeper", utterance: "门闩就在这里。" })] : []);
    const activity = readDirectState(running.state.executionState!, running.state).activities[0]!;
    const calls = f.transport.mock.calls.length;
    const released = await f.engine.step({ ...f.roster,
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
      player: { kind: "model", agentId: "player", profiles: f.world.initialState.agents.player!.modelProfiles, resumeFromRevision: 0 } },
    { expectedRevision: running.state.revision, trigger: "realtime", externalActions: [] });
    expect(released.committed.directEvent.frames).toMatchObject([{ id: activity.id, actorId: "player", submissionId: "submission-0" }]);
    expect(released.state.truth.elapsedSeconds).toBe(60);
    expect(readDirectState(released.state.executionState!, released.state).intents.player?.activeSubmission).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(calls + Number(changedEvidence));
    if (changedEvidence) {
      const rejudged = directDecisionContext(JSON.parse(String(f.transport.mock.calls.at(-1)![1]?.body)))!;
      expect(rejudged.state).toMatchObject({ playerAuthorization: { [activity.id]: { originalSubmission: { rawText: "查看门闩。", submissionId: "submission-0" } } } });
    }
    expect(replaySimulationState(released.state)).toEqual(released.state);
  });
  it("checks native player transfer authority before any real quantity handover", async () => {
    const f = await fixture({ operation: "transfer", recipient: "guard", amount: "n3", transferAuthority: "give",
      playerAuthorization: "outside_scope" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("问守门人需要几枚灵石，等他回答，不支付。"));
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(result.committed.events).toEqual([]);
    expect(result.committed.observations).toEqual([]);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(readDirectState(result.state.executionState!, result.state).intents.player?.status).toBe("failed");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("does not transfer an NPC payment when its prerequisite is an unadmitted same-batch player offer", async () => {
    const f = await fixture({ operation: "speak", recipient: "guard", creationEnabled: true, playerAuthorization: "outside_scope",
      keeperInitiative: true, worldOutcomes: { keeper: "unknown" },
      npcReadings: [npcReading({ operation: "transfer", resource: "spirit-stone", amount: "n1", utterance: null,
        attempt: "只有旅人实际提出一枚灵石的有效报价，我才支付一枚；没有报价就不交钱。" })],
      creationResponse: { attempt: "自行报价", utterance: "维修收你一枚灵石。", manner: null } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("我只免费检查门闩，不报价。"));
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper?.failure).toBeNull();
    expect(result.committed.directEvent.frames).toMatchObject([{ actorId: "keeper", kind: "transfer" }]);
    expect(result.committed.outcomes).toMatchObject([{ status: "blocked" }]);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(result.committed.observations.every(observation => observation.scene?.speech?.utterance !== "维修收你一枚灵石。")).toBe(true);
    expect(readDirectState(result.state.executionState!, result.state).intents.player?.status).toBe("failed");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retains the original input and completed receipts when a later NPC question tempts a new player quote", async () => {
    const text = "我免费查看门闩，检查之后做基础维护，不自行报价。";
    const question = "检查的结果怎么样？维护收多少钱？";
    const options: Parameters<typeof fixture>[0] = { operation: "observe", target: "door", speech: "none", creationEnabled: true,
      keeperInitiative: true, npcReadings: [npcReading({ utterance: question })], readingOverrides: { progress_next: "continue" } };
    const f = await fixture(options); await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request(text));
    expect(first.committed.directEvent.frames.some(frame => frame.actorId === "player" && frame.kind === "observe")).toBe(true);
    options.operation = "speak"; options.recipient = "guard"; options.speech = "create"; options.playerAuthorization = "outside_scope";
    options.creationResponse = { attempt: "诊断并报价", utterance: "门闩坏了，维修收三枚灵石。", manner: null };
    const second = await f.engine.step({ ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } },
      { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(second.committed.directEvent.frames).toEqual([]);
    expect(second.state.truth).toEqual(first.state.truth);
    const batch = second.committed.directEvent.decisions.find(use => use.batch.view.kind === "world")!.batch;
    const context = batch.state as { actions: Array<{ id: string }>; playerAuthorization: Record<string, unknown> };
    expect(context.playerAuthorization[context.actions[0]!.id]).toMatchObject({
      originalSubmission: { submissionId: "submission-0", rawText: text },
      completedSteps: [expect.objectContaining({ kind: "observe", outcome: expect.objectContaining({ status: "succeeded" }) })],
      deliveredSpeechSinceSubmission: expect.arrayContaining([expect.objectContaining({ speech: expect.objectContaining({ utterance: question }) })]),
    });
    expect(readDirectState(second.state.executionState!, second.state).intents.player!.activeSubmission?.rawText).toBe(text);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("admits an authorized follow-up report without equating truthful world feasibility with player scope", async () => {
    const text = "先检查门闩，再向守门人报告看到的状态。";
    const options: Parameters<typeof fixture>[0] = { operation: "observe", target: "door", speech: "none", creationEnabled: true,
      readingOverrides: { progress_next: "continue" } };
    const f = await fixture(options); await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request(text));
    options.operation = "speak"; options.recipient = "guard"; options.speech = "create"; options.readingOverrides = { progress_next: "complete" };
    options.creationResponse = { attempt: "报告已见的门闩状态", utterance: "我看到门闩还锁着。", manner: null };
    const second = await f.engine.step({ ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } },
      { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(second.committed.directEvent.frames).toMatchObject([{ actorId: "player", submissionId: "submission-0", utterance: "我看到门闩还锁着。" }]);
    expect(second.committed.observations.some(observation => observation.scene?.speech?.utterance === "我看到门闩还锁着。")).toBe(true);
    expect(readDirectState(second.state.executionState!, second.state).completedSubmissionIds).toContain("submission-0");
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("represents an ordinary new posture on the actor through the reusable effect path", async () => {
    const f = await fixture({ operation: "change", target: "door", effectExpansion: true, creationEnabled: true,
      creationResponse: { description: "Crouch beside the target", applicability: "The actor can crouch in this space",
        effectDescription: "The actor is crouching", effects: [{ kind: "fact", subject: "actor", predicate: "posture", value: "crouching", description: "蹲在目标旁边。" }] } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("在门旁蹲下"));
    expect(Object.values(result.state.truth.facts)).toContainEqual(expect.objectContaining({ subjectId: "player", predicate: "posture", value: { kind: "text", value: "crouching" } }));
    expect(result.committed.outcomes[0]?.status).toBe("succeeded");
    expect(result.committed.outcomes[0]!.summary).toBe("这次操作已完成。");
    expect(result.committed.observations[0]!.summary).not.toContain("Crouch beside the target");
    expect(Object.keys(result.state.truth.entities)).toEqual(Object.keys(f.world.initialState.truth.entities));
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["succeeded", "partial", "failed"])("distinguishes an admitted method without persistent effects from an unconfirmed result: %s", async outcome => {
    const f = await fixture({ operation: "use", target: "door", effectRepresentation: "no_change", outcome });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("用指尖轻敲一下门"));
    expect(result.committed.outcomes[0]?.status).toBe(outcome);
    expect(result.committed.outcomes[0]!.summary.includes("这次操作已完成")).toBe(outcome === "succeeded");
    expect(result.committed.outcomes[0]!.summary).not.toContain("用指尖轻敲一下门");
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("explains an already satisfied state without a repeated performed-method receipt", async () => {
    const f = await fixture({ operation: "use", target: "door", effectRepresentation: "already" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("让门保持原样"));
    expect(result.committed.outcomes[0]).toMatchObject({ status: "succeeded", summary: "当前已经处于所要求的状态，没有再次执行这个动作。" });
    expect(result.state.truth.facts).toEqual(f.world.initialState.truth.facts);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("retains the owner's specific inspection focus without exposing it as another observer's intention", async () => {
    const f = await fixture({ operation: "observe", target: "door", creationEnabled: true });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("检查门铰链有没有松动"));
    expect(result.committed.observations.find(item => item.observerId === "player")?.scene?.attempt).toBe("检查门铰链有没有松动");
    for (const observation of result.committed.observations.filter(item => item.observerId !== "player")) {
      expect(observation.scene?.attempt).toBe("");
    }
  });
  it.each([false, true])("repairs an omitted executed operation once and retains both audits (repeat failure: %s)", async repeatFailure => {
    const f = await fixture({ operation: "observe", target: "door", creationEnabled: true,
      creationResponse: { description: "门在眼前。", entities: [], facts: [], events: [] } });
    const transport = f.transport.getMockImplementation()!;
    let readings = 0;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const context = wire.questions ? null : directCreationContext(wire);
      const response = await transport(...args);
      if (!context?.playerReading) return response;
      readings++;
      if (readings === 2) expect(context.repair).toMatchObject({ issues: ["Action reading did not bind the selected action's operation"] });
      if (readings > 1 && !repeatFailure) return response;
      const body = await response.clone().json(), value = JSON.parse(body.choices[0].message.content);
      delete value.action.operation;
      body.choices[0].message.content = JSON.stringify(value);
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("看看门"));
    expect(readings).toBe(2);
    const audits = result.state.history[0]!.directEvent!.modelAudits.filter(audit => audit.promptVersion.startsWith("player-reading-"));
    expect(audits).toHaveLength(2);
    expect(new Set(audits.flatMap(audit => audit.invocations.map(invocation => invocation.id))).size).toBe(2);
    if (repeatFailure) {
      expect(result.state.truth).toEqual(f.world.initialState.truth);
      expect(readDirectState(result.state.executionState!, result.state).intents.player?.status).toBe("failed");
    } else expect(result.committed.outcomes[0]?.status).toBe("succeeded");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
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
  it.each([false, true])("bounds empty interpretation recovery and retains both calls (repeated failure: %s)", async repeatFailure => {
    const f = await fixture({ operation: "observe", target: "door", creationEnabled: true,
      creationResponse: { description: "门在眼前。", entities: [], facts: [], events: [] } });
    const transport = f.transport.getMockImplementation()!;
    let readings = 0;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const context = wire.questions ? null : directCreationContext(wire);
      const response = await transport(...args);
      if (!context?.playerReading) return response;
      readings++;
      if (readings > 1) { expect(context.repair).toBeTruthy(); if (!repeatFailure) return response; }
      const body = await response.clone().json(); body.choices[0].message.content = "";
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("检查门轴"));
    expect(readings).toBe(2);
    expect(result.state.history[0]!.directEvent!.frames).toHaveLength(repeatFailure ? 0 : 1);
    if (repeatFailure) {
      expect(result.state.truth).toEqual(f.world.initialState.truth);
      expect(readDirectState(result.state.executionState!, result.state).intents.player!.status).toBe("failed");
    } else expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(result.state.history[0]!.directEvent!.modelAudits.filter(audit => audit.promptVersion.startsWith("player-reading-"))).toHaveLength(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("repairs a missing movement target without silently searching or creating a destination", async () => {
    const f = await fixture({ operation: "move", target: "door", movement: "approach", creationEnabled: true });
    const transport = f.transport.getMockImplementation()!;
    let readings = 0;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const context = wire.questions ? null : directCreationContext(wire);
      const response = await transport(...args);
      if (!context?.playerReading) return response;
      readings++;
      if (readings > 1) {
        expect(context.repair).toMatchObject({ issues: expect.arrayContaining([expect.stringContaining("A move needs its actual destination")]) });
        return response;
      }
      const body = await response.clone().json(), value = JSON.parse(body.choices[0].message.content);
      value.action.target = "none"; body.choices[0].message.content = JSON.stringify(value);
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("挪到门旁"));
    expect(readings).toBe(2);
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "move", preparatoryFor: null });
    expect(Object.keys(result.state.truth.entities)).toEqual(Object.keys(f.world.initialState.truth.entities));
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["change", "move"])("expands an existing relation outside the finite catalog during %s", async operation => {
    const f = await fixture({ operation, target: operation === "move" ? "yard" : "self", creationEnabled: true, effectExpansion: true,
      effectRepresentation: "existing", factValues: { luggage_position: "new_value" }, creationResponse: {
        values: { p0: "carried at side" }, capability: null,
      } });
    f.world.initialState.truth.facts["luggage-place"] = { ...f.world.initialState.truth.facts["gate-lock"]!,
      id: "luggage-place", subjectId: f.world.initialState.agents.player!.entityId, predicate: "luggage_position",
      value: { kind: "text", value: "on lap" }, description: "行李放在膝上。", access: { kind: "public" } };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("提着行李站起来"));
    expect(result.state.truth.facts["luggage-place"]?.value).toEqual({ kind: "text", value: "carried at side" });
    expect(result.state.truth.facts["luggage-place"]?.description).not.toContain("膝上");
    expect(result.committed.observations.find(item => item.observerId === "player")?.summary).toContain("carried at side");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["change", "move"])("updates the actor's existing posture with a separate target during %s", async operation => {
    const f = await fixture({ operation, target: "door", factValues: { kneeling: "v1" } });
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
  it("keeps an approach to an enclosing destination inside that destination", async () => {
    const f = await fixture({ operation: "move", target: "yard", movement: "near", factValues: { proximity: "v1" } });
    f.world.initialState.truth.entities.region = { ...f.world.initialState.truth.entities.courtyard!, id: "region", name: "外区" };
    Object.assign(f.world.initialState.truth.placements, { player: "gate", gate: "courtyard", courtyard: "region", region: null });
    f.world.initialState.truth.facts["actor-proximity"] = { ...f.world.initialState.truth.facts["gate-lock"]!, id: "actor-proximity",
      subjectId: "player", predicate: "proximity", value: { kind: "entity", entityId: "gate" }, description: "在石门旁。", access: { kind: "public" } };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("朝院内退开两步"));
    expect(result.state.truth.placements.player).toBe("courtyard");
    expect(Object.values(result.state.truth.facts).filter(fact => fact.subjectId === "player" && fact.predicate === "proximity"))
      .toMatchObject([{ id: "actor-proximity", value: { kind: "entity", entityId: "courtyard" } }]);
    expect(result.committed.observations.find(observation => observation.observerId === "player")?.summary).not.toContain("外区");
    const proximity = Object.values(result.state.agents.player!.belief.claims).find(claim => claim.predicate === "proximity");
    expect(proximity).toMatchObject({ value: { kind: "local_entity", localEntityId: "yard" }, description: `我：proximity（${f.world.initialState.truth.entities.courtyard!.name}）` });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("can clear and reestablish a contact relation without a new capability", async () => {
    const options = { operation: "move", target: "yard", factValues: { contact: "v1" } };
    const f = await fixture(options);
    f.world.initialState.truth.facts["actor-contact"] = { ...f.world.initialState.truth.facts["gate-lock"]!,
      id: "actor-contact", subjectId: "player", predicate: "contact", value: { kind: "entity", entityId: "gate" },
      description: "扶着门框。", access: { kind: "public" } };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("松开扶着门框的手，走到院子里"));
    expect(result.state.truth.facts["actor-contact"]?.value).toEqual({ kind: "none" });
    expect(Object.values(result.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "contact", value: { kind: "none" }, description: "我：contact（无）" }));
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(readDirectState(result.state.executionState!, result.state).capabilities).toHaveLength(0);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    Object.assign(options, { operation: "change", target: "door", factValues: { contact: "v2" } });
    const restored = await engine.step(f.roster, f.request("再次用手扶住门框", result.state.revision));
    expect(restored.state.truth.facts["actor-contact"]?.value).toEqual({ kind: "entity", entityId: "gate" });
    expect(Object.values(restored.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "contact", value: { kind: "local_entity", localEntityId: "door" } }));
    expect(f.transport).toHaveBeenCalledTimes(6);
    expect(readDirectState(restored.state.executionState!, restored.state).capabilities).toHaveLength(0);
    expect(replaySimulationState(restored.state)).toEqual(restored.state);
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
    const cause = result.state.history[0]!.directEvent!.frames[0]!.id;
    const responding = privateActionView(result.state, "keeper", cause).state as { respondingTo: string; interactions: Array<{ id: string; utterance: string }> };
    expect(responding.interactions.find(item => item.id === responding.respondingTo)?.utterance).toBe("请先检查，然后告诉我你实际看到了什么。");
    expect(responding).not.toHaveProperty("conversation");
    expect(responding).not.toHaveProperty("ownSpeechSinceLastRecipientReply");
    expect(privateActionView(result.state, "keeper", "unobserved-action").state).toMatchObject({ respondingTo: null });
    const playerView = privateActionView(result.state, "player").state;
    expect(playerView).toMatchObject({ interactions: [{ relation: "self" }] });
    expect(JSON.stringify(playerView)).not.toContain("PRIVATE-CODE");
    const forgotten = structuredClone(result.state);
    const keeperObservationIds = new Set(forgotten.history.flatMap(step => step.observations)
      .filter(observation => observation.observerId === "keeper").map(observation => observation.id));
    for (const evidence of Object.values(forgotten.agents.keeper!.belief.evidence)) if (evidence.sourceId && keeperObservationIds.has(evidence.sourceId)) {
      delete forgotten.agents.keeper!.belief.evidence[evidence.id];
    }
    expect(privateActionView(forgotten, "keeper", cause).state).toMatchObject({ interactions: [], respondingTo: null });
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
    expect(second.committed).toMatchObject({ events: [], observations: [], directEvent: { frames: [], presentation: [] } });
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
      status: "failed", failure: { message: "Request completion requires a receipt from this submission; use clarification for a new input that requests no executable step" },
    });
    expect(readDirectState(result.state.executionState!, result.state).completedSubmissionIds).toEqual([]);
  });
  it("explains a fresh no-action reading without fabricating completion or failing the service", async () => {
    const f = await fixture({ interaction: "request_complete", readingOverrides: { operation: "none" }, creationEnabled: true });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("要是没有人在敲门，就别去开门。"));
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed).toMatchObject({ events: [], observations: [], directEvent: { frames: [],
      presentation: [{ kind: "clarification", requested: "要是没有人在敲门，就别去开门。" }] } });
    expect(readDirectState(result.state.executionState!, result.state).intents.player).toMatchObject({ status: "waiting", failure: null });
    expect(replaySimulationState(result.state)).toEqual(result.state);
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
  it.each(["speak", "observe"])("validates nullable catalog fields only on the executed %s branch", async operation => {
    const f = await fixture({ operation, recipient: "guard", speech: "input", creationEnabled: true,
      creationResponse: { attempt: "征求检查同意", utterance: "可以先检查吗？", manner: null } });
    const respond = f.transport.getMockImplementation()!;
    let readings = 0;
    f.transport.mockImplementation(async (...args) => {
      const wire = JSON.parse(String(args[1]?.body));
      const response = await respond(...args);
      if (wire.questions || !directCreationContext(wire).playerReading) return response;
      readings++;
      const body = await response.json();
      const reading = JSON.parse(body.choices[0].message.content);
      reading.action[operation === "speak" ? "tool" : "observation_scope"] = null;
      body.choices[0].message.content = JSON.stringify(reading);
      return Response.json(body);
    });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("可以先检查吗？"));
    if (operation === "speak") {
      expect(readings).toBe(1);
      expect(result.committed.directEvent.frames[0]).toMatchObject({ kind: "speak", toolEntityId: null });
      expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.scene?.speech?.utterance).toBe("可以先检查吗？");
    } else {
      expect(result.state.truth).toEqual(f.world.initialState.truth);
      expect(readDirectState(result.state.executionState!, result.state).intents.player!.status).toBe("failed");
    }
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
    expect(third.state.truth.elapsedSeconds, JSON.stringify(readDirectState(third.state.executionState!, third.state).intents.player)).toBe(32);
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
    expect(f.transport).toHaveBeenCalledTimes(3);
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
    expect(f.transport).toHaveBeenCalledTimes(3);
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
    expect(f.transport).toHaveBeenCalledTimes(3);
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
    const claimsOf = (value: unknown) => (value as { perspective: { knowledge: { claims: unknown[] } } }).perspective.knowledge.claims;
    expect(claimsOf(context).length).toBeGreaterThan(0);
    expect(context).not.toHaveProperty("currentObservedFacts");
    expect(context).not.toHaveProperty("latestObservedEvidence");
    expect(claimsOf(context)).toEqual(expect.arrayContaining(Object.values(observed.state.agents.player!.belief.claims).map(claim =>
      expect.objectContaining({ predicate: claim.predicate, value: claim.value, stance: claim.stance }))));
    expect(JSON.stringify(claimsOf(context))).not.toContain("PRIVATE-CODE");
    const choices = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).map(directDecisionContext).filter(wire => wire?.questions.operation);
    expect(claimsOf(choices.at(-1)!.state)).toEqual(claimsOf(context));
    expect((choices.at(-1)!.state as Record<string, unknown>).recentActions).toEqual([expect.objectContaining({ target: "door", requested: "查看门的状态", actionKind: "observe" })]);
    expect(JSON.stringify(claimsOf(choices.at(-1)!.state))).not.toContain("PRIVATE-CODE");
    expect(JSON.stringify((choices.at(-1)!.state as Record<string, unknown>).recentActions)).not.toContain("canonicalEntityIds");
    expect(replaySimulationState(f.engine.snapshot)).toEqual(f.engine.snapshot);
  });
  it("keeps an NPC's immediate physical follow-through linked to the triggering action", async () => {
    const f = await fixture({ operation: "speak", target: "guard", speech: "create", creationEnabled: true, reactionProgress: "continue",
      creationResponse: { attempt: "准备交付物品", utterance: "现在给你。", manner: null, recipientLocalId: "traveler" } });
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
      creationResponse: { attempt: expression ? "抬手指向门边并作答" : "回答是否可以通行", utterance: "这里可以通行。", manner: expression ? "抬手指向门边" : null } });
    await f.engine.bootstrapAgents();
    const first = await f.engine.step(f.roster, f.request("请问这里可以走吗？"));
    const second = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "batch", externalActions: [] });
    const reply = second.state.history.at(-1)!.directEvent!.frames.find(frame => frame.actorId === "keeper")!;
    expect(reply.utterance).toBe("这里可以通行。");
    expect(reply.expression?.manner).toBe(expression ? "抬手指向门边" : null);
    if (!expression) expect(reply.expression?.attempt).toBe("回答是否可以通行");
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
  it.each([true, false])("keeps movement independent of a visible or privately mental manner: %s", async visible => {
    const manner = visible ? "步子稳而快。" : "步子稳而快，边走边把要说的话理清。";
    const f = await fixture({ operation: "move", target: "guard", movement: "near", expression: 1, creationEnabled: true,
      mannerSupported: visible, creationResponse: { attempt: "走近守门人", utterance: null, manner } });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("走近守门人"));
    expect(result.state.truth.placements.player).toBe(result.state.truth.placements.keeper);
    const observed = result.committed.observations.find(o => o.observerId === "keeper")!;
    expect(observed.scene).toMatchObject({ actionKind: "move", status: "succeeded", manner: visible ? manner : null });
    const world = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))))
      .find(wire => wire?.questions.a0_manner)!;
    expect(JSON.stringify(world.state)).toContain("Private thoughts, motives, memories and silent mental preparation are not observable performance");
    expect(result.state.history[0]!.directEvent!.frames[0]!.expression?.manner).toBe(manner);
    expect(replaySimulationState(result.state)).toEqual(result.state);
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
    const reading = result.committed.observations[0]!.summary;
    expect(reading.match(/磨白的短外衣，怀里抱着木箱。/gu)).toHaveLength(1);
    expect(reading).not.toContain("抱木箱的人：抱木箱的人");
    expect(reading).not.toContain("你能看见其所在的位置");
    expect(reading).not.toContain("PRIVATE-MOTIVE");
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
  it("skips the exploration creator when existing scene content suffices", async () => {
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
  it("adjudicates a public observation with Jev and persists the actual observation", async () => {
    const f = await fixture(); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("查看石门"));
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(Object.values(result.state.agents.player!.belief.claims)).toContainEqual(expect.objectContaining({ predicate: "lock", value: { kind: "text", value: "sealed" } }));
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(result.modelAudits.filter(audit => audit.subjectId !== "keeper").every(audit => audit.protocol === "typesafe-systemone")).toBe(true);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("discovers a missing recipient before speech and retains the original player request", async () => {
    const f = await fixture({ operation: "speak", target: "none", recipient: "discover" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("寻找能回答的人，询问附近哪里能住宿"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "observe", preparatoryFor: "speak", utterance: null });
    const intent = readDirectState(result.state.executionState!, result.state).intents.player!;
    expect(intent.activeSubmission?.submissionId).toBe("submission-0"); expect(intent.status).toBe("ready");
    expect(f.transport).toHaveBeenCalledTimes(3); expect(replaySimulationState(result.state)).toEqual(result.state);
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
    expect(f.transport).toHaveBeenCalledTimes(4);
  });
  it("listens without inventing an utterance or starting another discovery loop", async () => {
    const f = await fixture({ operation: "wait", recipient: "none", speech: "none" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("听完对方的条件，暂时不承诺"));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "wait", utterance: null, preparatoryFor: null });
    expect(result.committed.observations[0]!.scene?.attempt).toBe("等候新的消息或条件变化");
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("does not pay the player's money when they asked the other person to deliver", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", transferAuthority: "request", speech: "q0" });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request('请守门人交还灵石，说：“请把东西交给我。”'));
    expect(result.state.history[0]!.directEvent!.frames[0]).toMatchObject({ kind: "speak", utterance: "请把东西交给我。" });
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
  });
  it.each([false, true])("reports a targeted self quantity only when that inspection measures it (%s)", async measured => {
    const f = await fixture({ operation: "observe", target: "self", quantityMeasured: measured }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request(measured ? "数清我手里的灵石" : "只看看自己的手心与脸色，不检查钱袋"));
    const observation = result.committed.observations.find(packet => packet.observerId === "player")!;
    expect(observation.summary.includes("3枚灵石")).toBe(measured);
    expect(observation.summary).not.toContain("随身物资");
    expect(result.committed.directEvent.frames[0]).toMatchObject({ kind: "observe", targetEntityId: "player", observationScope: "target" });
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
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
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it.each(["给守门人2枚灵石", "给守门人两颗灵石"])("transfers the selected amount atomically and replays without charging twice: %s", async text => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n2" }); await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request(text));
    const player = quantityId(result.state.worldHash, "spirit-stone", "player"), keeper = quantityId(result.state.worldHash, "spirit-stone", "keeper");
    expect(result.state.truth.quantities[player]!.amount).toBe(1); expect(result.state.truth.quantities[keeper]!.amount).toBe(22);
    const restored = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(result.state)));
    expect(restored.snapshot.truth.quantities[player]!.amount).toBe(1);
    expect(replaySimulationState(result.state)).toEqual(result.state); expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("retains a remembered payment amount after newer observations without reading another mind", async () => {
    const options: Parameters<typeof fixture>[0] = { operation: "speak", target: "guard", recipient: "guard", speech: "input" };
    const f = await fixture(options);
    f.world.initialState.agents.keeper!.belief.evidence["agreed-price"] = {
      id: "agreed-price", kind: "testimony", description: "先前约定向旅人支付 7 枚灵石。", sourceId: "traveler", step: 0,
    };
    f.world.initialState.agents.player!.belief.evidence["private-price"] = {
      id: "private-price", kind: "observation", description: "另一个私下报价是 113 枚灵石。", sourceId: "self", step: 0,
    };
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    const engine = new SimulationEngine(f.world, f.algorithm);
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, f.request("早上好。"));
    const state = result.state, keeper = state.agents.keeper!;
    expect(keeper.observationCursorStep).toBeGreaterThan(keeper.belief.evidence["agreed-price"]!.step);
    const control = readDirectState(state.executionState!, state);
    control.intents.keeper = readyIntent("observation");
    Object.assign(options, { operation: "transfer", target: "traveler", recipient: "traveler", amount: "n7", keeperInitiative: true });
    const decisions = new DirectDecisions(f.gateway, control, { workloadId: "remembered-payment", batchId: "keeper-payment",
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
    const calls = f.transport.mock.calls.length;
    const chosen = await chooseAction({ state, definition: toWorldRuntimeContract(f.world), control,
      decisions, agentId: "keeper", creationEnabled: false });
    const readings = f.transport.mock.calls.slice(calls).map(([, init]) => directCreationContext(JSON.parse(String(init?.body))))
      .map(context => context.autonomousReading as { catalog: { amount: Record<string, unknown> } } | undefined).filter(Boolean);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.catalog.amount).toHaveProperty("n7");
    expect(readings[0]!.catalog.amount).not.toHaveProperty("n113");
    expect(chosen.frame).toMatchObject({ kind: "transfer", targetEntityId: "player", amount: 7, quantityDefinitionId: "spirit-stone" });
  });
  it("transfers five units when a script's unit is also a Chinese numeral", async () => {
    const f = await fixture({ operation: "transfer", target: "guard", amount: "n5", resourceUnit: "两", openingQuantity: 40 });
    await f.engine.bootstrapAgents();
    const result = await f.engine.step(f.roster, f.request("从自己的钱中给守门人五两灵石"));
    expect(result.state.truth.quantities[quantityId(result.state.worldHash, "spirit-stone", "player")]!.amount).toBe(35);
    expect(result.state.truth.quantities[quantityId(result.state.worldHash, "spirit-stone", "keeper")]!.amount).toBe(25);
    expect(result.state.history[0]!.directEvent!.frames[0]!.amount).toBe(5);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("offers unit-bounded amounts without reinterpreting a complete numeral's middle unit", () => {
    expect(literalNumbers("五两银，三十两银", ["两"])).toEqual([5, 30, 52, 32]);
    expect(literalNumbers("一万两千枚灵石", ["两", "枚"])).toEqual([12000]);
    expect(literalNumbers("5箱与三份", ["箱", "份"])).toEqual([5, 3]);
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
    const privateRequests = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).map(directDecisionContext).filter(wire => (wire?.state as { perspective?: unknown } | undefined)?.perspective);
    expect(JSON.stringify(privateRequests)).not.toContain("canonicalEntityIds");
    expect(JSON.stringify(privateRequests)).not.toContain('"truth"');
  });
  it("stops repeated non-progress work until relevant evidence changes", async () => {
    const f = await fixture({ operation: "observe", target: "self", keeperInitiative: true }); await f.engine.bootstrapAgents();
    f.roster.player = { kind: "idle", agentId: "player", reason: "explicit" };
    for (let revision = 0; revision < 3; revision++) {
      try { await f.engine.step(f.roster, { expectedRevision: revision, trigger: "manual", externalActions: [] }); }
      catch (error) { if (!(error instanceof WorldQuiescentError)) throw error; break; }
    }
    const state = f.engine.snapshot, intent = readDirectState(state.executionState!, state).intents.keeper!;
    expect(intent.failure).toBeNull();
    expect(intent.noProgressCount).toBeGreaterThanOrEqual(1); expect(["same-input", "no-progress"]).toContain(intent.wait!.reason);
    const calls = f.transport.mock.calls.length;
    await expect(f.engine.step(f.roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] })).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(state)).toEqual(state);
  });
});
