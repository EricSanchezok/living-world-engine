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

async function fixture(options: { operation?: string; target?: string; tool?: string; amount?: string; failKeeper?: boolean } = {}) {
  const f = directTestProvider(wire => {
    const context = wire.state as { perspective?: { agentId: string }; submittedAction?: { rawText: string } };
    if (options.failKeeper && context.perspective?.agentId === "keeper") return new Response("unavailable", { status: 503 });
    const selection: Record<string, string> = { operation: options.operation ?? "observe", target: options.target ?? "door", tool: options.tool ?? "none",
      amount: options.amount ?? "n0", resource: "spirit-stone", speech: "q0", timing: "default", goal: "none" };
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      let value = selection[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : id.includes("visible") ? "visible" : id.includes("delivery") ? "delivered" : id.includes("fact") ? "unchanged" : "none");
      if (q.type === "choice" && !(value in q.criteria)) value = "none" in q.criteria ? "none" : Object.keys(q.criteria)[0]!;
      return [id, nativeAnswer(q, value)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  const player = world.initialState.agents.player!;
  for (const [id, canonicalId] of [["door", "gate"], ["guard", "keeper"], ["yard", "courtyard"]]) {
    player.belief.localEntities[id!] = { id: id!, name: world.initialState.truth.entities[canonicalId!]!.name, description: "Seen nearby", status: "observed" };
    player.bindings[id!] = { localEntityId: id!, canonicalEntityIds: [canonicalId!] };
  }
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: false });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = { player: { kind: "external", agentId: "player", participantId: "human" },
    keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles } };
  const request = (text: string, revision = 0): WorldAdvanceRequest => ({ expectedRevision: revision, trigger: "participant_action", externalActions: [
    { agentId: "player", submissionId: `submission-${revision}`, rawText: text, goal: text, means: null, targetIds: [] } ] });
  return { ...f, world, algorithm, engine, roster, request };
}

describe("direct world through the actual simulation entry", () => {
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
