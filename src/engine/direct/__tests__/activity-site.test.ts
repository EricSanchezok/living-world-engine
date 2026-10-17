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

async function fixture(mode: "repair" | "repair-stale-time" | "repeat" | "current" | "speech" | "unknown") {
  let readings = 0, selectedOperation = "wait";
  const f = directTestProvider(wire => {
    const context = wire.messages ? directCreationContext(wire) : {};
    if (context.playerReading) {
      readings++;
      const continuation = (wire.state as { currentRequestReceipts: unknown[] }).currentRequestReceipts.length > 0;
      const operation = mode === "speech" ? "speak" : mode.startsWith("repair") && readings === 2 ? "move" : "wait";
      selectedOperation = operation;
      if (mode.startsWith("repair") && readings === 2) expect(context.repair).toMatchObject({ issues: [expect.stringContaining("different place")] });
      return { understanding: "Perform the next authorized step at its required place.",
        ...(mode === "repair-stale-time" && readings === 2 ? { durationReference: { basis: "phase_occurrence", count: 1 } } : {}),
        activitySite: mode === "current" ? "home-alias" : mode === "speech" ? "current" : mode === "unknown" ? "unresolved" : "room-ref",
        interaction: mode === "unknown" ? "clarification" : "world_action",
        action: { operation, target: "room-ref", recipient: "broadcast", tool: "none", resource: "none", amount: "unknown",
          timing: "default", duration: operation === "wait" ? "d0" : "default", interruption: "none",
          goal: "none", progress_next: operation === "move" ? "continue" : "complete", observation_scope: "target",
          attempt: operation === "move" ? "Enter the workroom." : operation === "speak" ? "Describe a future plan." : continuation ? "Rest in the workroom." : "Rest at the requested site.",
          utterance: operation === "speak" ? "I might work in that room tomorrow." : null, manner: null, literalQuote: "none" } };
    }
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question,
      id.endsWith("_duration") ? "s1" : id.endsWith("_movement") ? "enter" : id.endsWith("_request_progress") ? selectedOperation === "move" ? "continue" : "complete"
        : id.includes("outcome") ? "succeeded" : id.includes("visible") ? "visible" : id.includes("delivery") ? "delivered" : id.includes("fact") ? "unchanged" : "none")]));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 19, modelCatalog: f.catalog });
  world.initialState.truth.timers = {};
  world.initialState.truth.entities.workroom = { ...world.initialState.truth.entities.courtyard!, id: "workroom", name: "Workroom", description: "A separate workroom off the courtyard." };
  world.initialState.truth.placements.workroom = "courtyard";
  const player = world.initialState.agents.player!;
  for (const [localId, canonicalId] of [["home-alias", "courtyard"], ["home-second-alias", "courtyard"], ["room-ref", "workroom"]]) {
    player.belief.localEntities[localId!] = { id: localId!, name: canonicalId === "workroom" ? "Workroom" : "Courtyard", description: "A known place.", status: "observed" };
    player.bindings[localId!] = { localEntityId: localId!, canonicalEntityIds: [canonicalId!] };
  }
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const engine = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true }));
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(world.initialState.agents).map(agentId => [agentId, { kind: "external", agentId, participantId: "operator" }]));
  await engine.bootstrapAgents();
  const actions = [{ agentId: "player", submissionId: "site", rawText: mode === "speech" ? 'Say "I might work in that room tomorrow."' : "Rest at the requested place for 60 seconds.", goal: "Rest", means: null, targetIds: [] }];
  return { ...f, world, engine, roster, actions, readings: () => readings };
}

describe("player activity execution sites", () => {
  it("repairs a different-site wait into a real move and continues only after arrival", async () => {
    const f = await fixture("repair");
    const moved = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(f.readings()).toBe(2);
    expect(moved.state.truth.placements.player).toBe("workroom");
    expect(moved.state.truth.elapsedSeconds).toBe(1);
    expect(moved.committed.directEvent.frames[0]!.kind).toBe("move");
    const rested = await f.engine.step(f.roster, { expectedRevision: moved.state.revision, trigger: "manual", externalActions: [] });
    expect(rested.state.truth.placements.player).toBe("workroom");
    expect(rested.state.truth.elapsedSeconds).toBe(61);
    expect(rested.committed.directEvent.frames[0]!.kind).toBe("wait");
    expect(replaySimulationState(rested.state)).toEqual(rested.state);
  });

  it("rejects a repaired movement that still carries the later activity's phase reference", async () => {
    const f = await fixture("repair-stale-time");
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(f.readings()).toBe(2);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.directEvent.frames).toEqual([]);
    const intent = readDirectState(result.state.executionState!, result.state).intents.player!;
    expect(intent.status).toBe("failed");
    expect(intent.failure?.message).toContain("prerequisite uses its own timing");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("rejects a second inconsistent site without committing the attempted wait", async () => {
    const f = await fixture("repeat");
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(f.readings()).toBe(2);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.status).toBe("failed");
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["current", "speech", "unknown"] as const)("preserves the %s branch without adding travel", async mode => {
    const f = await fixture(mode);
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(f.readings()).toBe(1);
    expect(result.state.truth.placements.player).toBe("courtyard");
    expect(result.committed.directEvent.frames.map(frame => frame.kind)).toEqual(mode === "unknown" ? [] : [mode === "speech" ? "speak" : "wait"]);
    expect(result.state.truth.elapsedSeconds).toBe(mode === "unknown" ? 0 : mode === "current" ? 60 : 1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
