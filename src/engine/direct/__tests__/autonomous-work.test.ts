import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer, directCreationContext } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { quantityId } from "../../runtime/runtime-id";
import { readDirectState, sealDirectState } from "../state";
import type { PolicyBinding } from "../../runtime/execution";

type Mode = "repair" | "repeat" | "unknown" | "misbound" | "count" | "watch" | "unsupported-manner" | "supported-manner";
async function fixture(mode: Mode, delayed = false) {
  let readings = 0;
  const f = directTestProvider(wire => {
    const context = wire.messages ? directCreationContext(wire) : {};
    if (context.autonomousReading) {
      readings++;
      const operation = mode === "repair" && readings === 2 || mode === "misbound" ? "move"
        : mode === "unknown" && readings > 1 || mode.endsWith("manner") ? "speak" : "observe";
      const target = operation === "move" ? mode === "misbound" ? "hall-ref" : "room-ref" : "stock-ref";
      const activitySite = mode === "repeat" || mode === "repair" ? "room-ref" : mode === "unknown" && readings === 1 ? "unresolved" : "current";
      return { understanding: "Inspect this stock, then report the observed count.", urgency: 0.5, interaction: "world_action", activitySite,
        action: { operation, target, recipient: "traveler", tool: "none", resource: "none", amount: "unknown", timing: ["count", "watch"].includes(mode) ? "ongoing-action" : "default",
          duration: "default", interruption: "none", goal: "none", progress_next: "complete", observation_scope: "target",
          attempt: operation === "move" ? "Go into the separate workroom to inspect its stock later." : operation === "speak" ? "Ask for information without moving." : mode === "watch" ? "Watch the stock continuously until relieved." : "Count this finite stack, then end the inspection.",
          utterance: operation === "speak" ? "Do you know where the account room is?" : null,
          manner: mode === "unsupported-manner" ? "Hands over the ledger that was fetched from the account room." : mode === "supported-manner" ? "Raises an empty hand in greeting." : null,
          literalQuote: "none" } };
    }
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question,
      id.endsWith("_outcome") ? mode === "misbound" ? "unknown" : "succeeded" : id.endsWith("_manner") ? mode === "unsupported-manner" ? "unsupported" : "supported"
        : id.endsWith("_extent") ? mode === "watch" ? "ongoing" : "bounded" : id.endsWith("_duration") ? mode === "count" || delayed ? "s60" : "planned"
        : id.endsWith("_movement") ? "enter" : /_quantity\d+$/u.test(id) ? "measured"
        : id.includes("visible") || id.includes("actor_visibility") || /_entity\d+$/u.test(id) ? "visible" : id.includes("delivery") ? "delivered" : id.includes("fact") ? "unchanged" : "none")]));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: f.catalog });
  const state = world.initialState;
  state.truth.timers = delayed ? { "intervening-timer": { id: "intervening-timer", description: "An unrelated earlier clock boundary.",
    createdAtSeconds: 0, dueAtSeconds: 1, status: "scheduled", wakeAgentIds: [], causes: [{ kind: "mechanic", id: "direct-world-clock" }],
    assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }] } } : {};
  state.truth.entities.workroom = { ...state.truth.entities.courtyard!, id: "workroom", name: "Workroom", description: "A distinct adjoining room." };
  state.truth.entities.stock = { ...state.truth.entities.gate!, id: "stock", name: "Stock", kind: "item", description: "A finite exposed stockpile." };
  state.truth.placements.workroom = "courtyard";
  state.truth.placements.stock = "workroom";
  if (["count", "watch"].includes(mode)) state.truth.placements.keeper = "workroom";
  const stockId = quantityId(state.worldHash, "spirit-stone", "stock");
  state.truth.quantities[stockId] = { id: stockId, definitionId: "spirit-stone", holderId: "stock", amount: 60 };
  state.truth.facts["stock-owner"] = { id: "stock-owner", subjectId: "stock", predicate: "owner", value: { kind: "entity", entityId: "player" },
    description: "The traveler owns the stock.", access: { kind: "public" }, provenance: [{ kind: "world_seed", id: state.worldHash }] };
  const agent = state.agents.keeper!;
  for (const [localId, canonicalId] of [["hall-ref", "courtyard"], ["room-ref", "workroom"], ["stock-ref", "stock"]] as const) {
    agent.belief.localEntities[localId] = { id: localId, name: state.truth.entities[canonicalId]!.name, description: "Known through earlier work.", status: "observed" };
    agent.bindings[localId] = { localEntityId: localId, canonicalEntityIds: [canonicalId] };
  }
  world.historyBaseHash = historyReplayBaseHash(state);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: false });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = { player: { kind: "idle", agentId: "player", reason: "explicit" },
    keeper: { kind: "model", agentId: "keeper", profiles: agent.modelProfiles } };
  await engine.bootstrapAgents();
  const advance = () => engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "manual", externalActions: [] });
  return { ...f, world, algorithm, roster, engine, advance, readings: () => readings, stockId };
}

describe("autonomous local work commits actual next steps", () => {
  it("repairs a remote inspection into arrival, then measures real stock without transferring it", async () => {
    const f = await fixture("repair");
    const moved = await f.advance();
    expect(f.readings()).toBe(2);
    expect(moved.state.truth.placements.keeper).toBe("workroom");
    expect(moved.committed.directEvent.frames[0]).toMatchObject({ kind: "move", targetEntityId: "workroom" });
    expect(moved.committed.observations.find(packet => packet.observerId === "keeper")?.summary).not.toContain("60");
    const inspected = await f.advance();
    expect(inspected.committed.directEvent.frames[0]).toMatchObject({ kind: "observe", targetEntityId: "stock" });
    expect(inspected.committed.observations.find(packet => packet.observerId === "keeper")?.summary).toContain("60枚灵石");
    expect(inspected.state.truth.quantities[f.stockId]!.amount).toBe(60);
    expect(inspected.state.truth.facts["stock-owner"]).toEqual(f.world.initialState.truth.facts["stock-owner"]);
    expect(replaySimulationState(inspected.state)).toEqual(inspected.state);
  });
  it("fails a repeated remote-site contradiction without committing time or arrival", async () => {
    const f = await fixture("repeat"), result = await f.advance();
    expect(f.readings()).toBe(2);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(readDirectState(result.state.executionState!, result.state).intents.keeper!.status).toBe("failed");
  });
  it("repairs an unknown destination into a real current-site question", async () => {
    const f = await fixture("unknown"), result = await f.advance();
    expect(f.readings()).toBe(2);
    expect(result.state.truth.placements.keeper).toBe("courtyard");
    expect(result.committed.directEvent.frames[0]).toMatchObject({ kind: "speak", targetEntityId: "player" });
    expect(result.committed.observations.find(packet => packet.observerId === "player")?.scene?.speech?.utterance).toContain("account room");
  });
  it("does not publish movement when world adjudication finds the target mismatches the immediate attempt", async () => {
    const f = await fixture("misbound"), result = await f.advance();
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(result.committed.operations.some(operation => operation.kind === "place_entity")).toBe(false);
    expect(result.state.truth.placements.keeper).toBe("courtyard");
    expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.summary).not.toContain("来到");
  });
  it.each(["count", "watch"] as const)("distinguishes finite scope from sustained work: %s", async mode => {
    const f = await fixture(mode), result = await f.advance();
    const control = readDirectState(result.state.executionState!, result.state);
    expect(result.state.truth.elapsedSeconds).toBe(mode === "count" ? 60 : 1);
    expect(control.activities).toHaveLength(mode === "watch" ? 1 : 0);
    if (mode === "watch") expect(control.activities[0]!.dueAtSeconds).toBeNull();
    expect(result.committed.observations.find(packet => packet.observerId === "keeper")?.summary).toContain("60枚灵石");
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["unsupported-manner", "supported-manner"] as const)("preserves expression admission through a timer and restart without another judgment: %s", async mode => {
    const f = await fixture(mode, true), admitted = await f.advance();
    expect(admitted.state.truth.elapsedSeconds).toBe(1);
    expect(admitted.committed.outcomes).toEqual([]);
    const control = readDirectState(admitted.state.executionState!, admitted.state);
    const frame = control.activities[0]!, preparation = control.prepared[frame.id]!;
    expect(frame.expression!.manner).toBeTruthy();
    expect(preparation.visibleManner).toBe(mode === "supported-manner" ? frame.expression!.manner : null);
    const restored = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(admitted.state)));
    const settled = await restored.step(f.roster, { expectedRevision: admitted.state.revision, trigger: "manual", externalActions: [] });
    expect(settled.state.truth.elapsedSeconds).toBe(60);
    expect(settled.committed.observations.map(packet => packet.scene?.manner)).toEqual([preparation.visibleManner, preparation.visibleManner]);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(replaySimulationState(settled.state)).toEqual(settled.state);
  });
  it("rejects a persisted preparation that omits its required expression admission", async () => {
    const f = await fixture("watch"), result = await f.advance();
    const control = readDirectState(result.state.executionState!, result.state);
    const prepared = Object.values(control.prepared)[0]!;
    delete (prepared as Partial<typeof prepared>).visibleManner;
    const executionState = result.state.executionState!;
    const invalid = { ...executionState, data: sealDirectState(control) as unknown as typeof executionState.data };
    expect(() => readDirectState(invalid, result.state)).toThrow("invalid direct runtime state");
  });
  it.each(["unsupported-manner", "supported-manner"] as const)("admits expressive delivery independently of delivered words: %s", async mode => {
    const f = await fixture(mode), result = await f.advance();
    const manner = result.committed.directEvent.frames[0]!.expression!.manner;
    expect(manner).not.toBeNull();
    expect(result.committed.observations.map(packet => packet.scene?.manner)).toEqual([mode === "supported-manner" ? manner : null, mode === "supported-manner" ? manner : null]);
    expect(result.committed.observations.every(packet => packet.scene?.speech?.utterance)).toBe(true);
    expect(result.state.truth.entities).toEqual(f.world.initialState.truth.entities);
    expect(result.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
