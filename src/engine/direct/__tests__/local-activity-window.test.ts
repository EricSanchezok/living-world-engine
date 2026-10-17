import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer, directCreationContext } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { readDirectState } from "../state";
import type { PolicyBinding } from "../../runtime/execution";

async function fixture(mode: "reservation" | "repeat" | "departure" | "fairness" = "reservation") {
  const reads: Record<string, number> = {};
  const f = directTestProvider(wire => {
    const context = wire.messages ? directCreationContext(wire) : {};
    const reading = (context.playerReading ?? context.autonomousReading) as { state: { perspective: { agentId: string } }; catalog: Record<string, unknown> } | undefined;
    if (reading) {
      const actor = reading.state.perspective.agentId, count = reads[actor] = (reads[actor] ?? 0) + 1;
      expect(JSON.stringify(reading)).not.toContain("canonicalEntityIds");
      expect(JSON.stringify(reading)).not.toContain('"truth"');
      const operation = actor === "player" ? mode === "fairness" && count === 1 ? "speak" : "wait" : mode === "departure" && actor === "seller" && [2, 3].includes(count) ? "move" : mode === "repeat" || actor === "keeper" && count === 1 || actor === "seller" && count === (mode === "departure" ? 4 : 2) ? "speak" : "wait";
      const privateNotice = mode === "fairness" && actor === "player" && operation === "speak";
      const utterance = operation === "speak" ? privateNotice ? "I will rest here." : actor === "keeper" ? "Can you reserve these goods?" : "I can reserve them until the next visit." : null;
      return { understanding: operation === "speak" ? "Discuss the local reservation." : "Wait for the relevant reply without repeating the exchange.",
        ...(actor === "player" ? {} : { urgency: 0.5 }), interaction: "world_action",
        action: { operation, target: operation === "move" ? count === 2 ? "store-local" : "yard-local" : "none", recipient: actor === "keeper" ? "seller-local" : "buyer-local", tool: "none", resource: "none", amount: "unknown",
          timing: "default", duration: actor === "player" && operation === "wait" ? "d0" : "default", interruption: "none", goal: "none", progress_next: mode === "fairness" && actor === "player" && count === 1 ? "continue" : "complete", observation_scope: "target",
          attempt: privateNotice ? "Whisper to the buyer that I will rest here." : operation === "speak" ? "Discuss the requested reservation." : "Rest until the requested time, or wait for a new relevant message.", utterance, manner: privateNotice ? "A quiet aside only the buyer can hear." : null, literalQuote: "none" } };
    }
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      const contact = (question.instructions as { task?: { data?: { actionId: string; recipient: string } } }).task?.data;
      const action = (wire.state as { actions?: Array<{ id: string; actorId: string }> }).actions?.find(frame => frame.id === contact?.actionId);
      const privateNoticeUnavailable = mode === "fairness" && action?.actorId === "player" && contact?.recipient !== "keeper";
      return [id, nativeAnswer(question,
      id.endsWith("_duration") ? "s1" : id.endsWith("_movement") ? "enter" : id.endsWith("_request_progress") ? mode === "departure" && [2, 3].includes(reads.seller ?? 0) ? "continue" : "complete" : id.includes("outcome") ? "succeeded"
        : id.includes("visible") ? "visible" : id.includes("delivery") ? privateNoticeUnavailable ? "unavailable" : "delivered" : id.includes("fact") ? "unchanged" : "none")];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 27, modelCatalog: f.catalog });
  world.initialState.truth.timers = {};
  const source = world.initialState;
  source.agents.keeper!.character.goals = {};
  source.agents.keeper!.character.commitments = {};
  for (const [id, place] of [["seller", "courtyard"], ["distant", "remote"]]) {
    const entityId = `${id}-entity`;
    source.truth.entities[entityId] = { ...source.truth.entities.keeper!, id: entityId, name: id! };
    source.truth.placements[entityId] = place!;
    const agent = source.agents[id!] = structuredClone(source.agents.keeper!);
    agent.id = id!; agent.entityId = entityId;
    for (const binding of Object.values(agent.bindings)) binding.canonicalEntityIds = binding.canonicalEntityIds.map(value => value === "keeper" ? entityId : value);
  }
  source.truth.entities.remote = { ...source.truth.entities.courtyard!, id: "remote", name: "Unrelated distant region" };
  source.truth.placements.remote = null;
  source.truth.entities.store = { ...source.truth.entities.courtyard!, id: "store", name: "Store across the road" };
  source.truth.placements.store = null;
  for (const agent of Object.values(source.agents)) for (const [localId, entityId] of [["seller-local", "seller-entity"], ["buyer-local", "keeper"], ["store-local", "store"], ["yard-local", "courtyard"]]) {
    if (entityId === agent.entityId) continue;
    agent.belief.localEntities[localId!] = { id: localId!, name: localId!, description: "An already known contact.", status: "observed" };
    agent.bindings[localId!] = { localEntityId: localId!, canonicalEntityIds: [entityId!] };
  }
  world.historyBaseHash = historyReplayBaseHash(source);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(source.agents).map(agentId => [agentId,
    agentId === "player" ? { kind: "external", agentId, participantId: "operator" } : { kind: "model", agentId, profiles: source.agents[agentId]!.modelProfiles }]));
  await engine.bootstrapAgents();
  return { ...f, world, engine, algorithm, roster, reads };
}

describe("local causal work during participant activities", () => {
  it("quiesces repeated unchanged NPC dialogue without discarding the participant deadline", async () => {
    const f = await fixture("repeat");
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [
      { agentId: "player", submissionId: "long-rest", rawText: "Rest quietly for 3600 seconds.", goal: "Rest", means: null, targetIds: [] },
    ] });
    for (let n = 0; result.state.truth.elapsedSeconds < 3600 && n < 12; n++) {
      result = await f.engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    }
    expect(result.state.truth.elapsedSeconds).toBe(3600);
    expect(f.reads.keeper).toBeLessThanOrEqual(4);
    expect(f.reads.seller).toBeLessThanOrEqual(4);
    expect(f.reads.distant).toBeUndefined();
  });
  it("batches local work with direct participant reactions between the participant's authorized steps", async () => {
    const f = await fixture("fairness");
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [
      { agentId: "player", submissionId: "long-rest", rawText: "Whisper to the buyer that I will rest, then rest quietly for 3600 seconds.", goal: "Rest", means: null, targetIds: [] },
    ] });
    const control = readDirectState(result.state.executionState!, result.state);
    expect(control.intents.keeper!.causeActionId).toBe(result.committed.directEvent.frames.find(frame => frame.actorId === "player")!.id);
    expect(control.intents.seller!.causeActionId).toBe(result.committed.directEvent.frames.find(frame => frame.actorId === "keeper")!.id);
    result = await f.engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(f.reads.keeper).toBe(2);
    expect(f.reads.seller).toBe(2);
    expect(result.committed.directEvent.frames).toContainEqual(expect.objectContaining({ actorId: "seller", kind: "speak" }));
    expect(f.reads.distant).toBeUndefined();
  });
  it("keeps a local request's real departure and return eligible across restart", async () => {
    const f = await fixture("departure");
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [
      { agentId: "player", submissionId: "long-rest", rawText: "Rest quietly for 3600 seconds.", goal: "Rest", means: null, targetIds: [] },
    ] });
    result = await f.engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.state.truth.placements["seller-entity"]).toBe("store");
    const restarted = new SimulationEngine(f.world, f.algorithm, structuredClone(result.state));
    result = await restarted.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.state.truth.placements["seller-entity"]).toBe("courtyard");
    for (let n = 0; result.state.truth.elapsedSeconds < 3600 && n < 10; n++) {
      result = await restarted.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    }
    const replies = result.state.history.flatMap(step => step.directEvent?.frames ?? []).filter(frame => frame.actorId === "seller" && frame.kind === "speak");
    expect(replies).toHaveLength(1);
    expect(replies[0]!.dueAtSeconds).toBeLessThan(3600);
    expect(result.state.truth.elapsedSeconds).toBe(3600);
    expect(f.reads.distant).toBeUndefined();
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("lets a ready local seller answer another NPC before the participant's long rest ends", async () => {
    const f = await fixture();
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [
      { agentId: "player", submissionId: "long-rest", rawText: "Rest quietly for 3600 seconds.", goal: "Rest", means: null, targetIds: [] },
    ] });
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(readDirectState(result.state.executionState!, result.state).intents.seller!.status).toBe("ready");
    const restarted = new SimulationEngine(f.world, f.algorithm, structuredClone(result.state));
    result = await restarted.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.committed.directEvent.frames).toContainEqual(expect.objectContaining({ actorId: "seller", kind: "speak" }));
    expect(result.state.truth.elapsedSeconds).toBeLessThan(3600);
    for (let n = 0; readDirectState(result.state.executionState!, result.state).activities.length && n < 10; n++) {
      result = await restarted.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    }
    expect(result.state.truth.elapsedSeconds).toBe(3600);
    expect(f.reads.distant).toBeUndefined();
    expect(f.reads.keeper).toBeLessThanOrEqual(3);
    expect(f.reads.seller).toBeLessThanOrEqual(3);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
