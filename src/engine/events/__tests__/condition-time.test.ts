import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { deriveConditionAdvance } from "../../mechanics/condition-time";
import { mergeCondition } from "../../mechanics/resolution";
import { applyWorldDeltaOperation, replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { SimulationEngine } from "../../runtime/simulation";
import { DecisionEventAlgorithm } from "../algorithm";
import { nextWorldClockBoundary } from "../clock-boundary";
import { worldResources } from "../resources";
import { commitWorldEvent, createWorldEventCandidate } from "../kernel";
import type { SimulationState } from "../../contracts/model";

function fixture() {
  const f = nativeProgramFixture(), state = f.world.initialState;
  state.truth.mechanics.durationProfiles.timed = { id: "timed", name: "Timed", kind: "elapsed", seconds: 25 };
  state.truth.mechanics.conditionProfiles.burning = { id: "burning", name: "Burning", stackingKey: "burning",
    defaultDurationProfileId: "timed", recurringImpactProfileId: "harm", recurringIntervalSeconds: 10, recovery: null, thresholds: [] };
  state.truth.conditions.burning = { id: "burning", subjectId: "keeper", label: "Burning", description: "The subject is burning.",
    magnitude: "minor", conditionProfileId: "burning", durationProfileId: "timed", stackingKey: "burning", remainingUses: null,
    expiresAtElapsedSeconds: 25, nextImpactAtElapsedSeconds: 10, access: { kind: "public" }, provenance: [{ kind: "law", id: state.lawIds[0]! }] };
  f.world.historyBaseHash = historyReplayBaseHash(state);
  return f;
}
function advance(state: SimulationState, end: number) {
  const next = structuredClone(state);
  for (const operation of deriveConditionAdvance({ state: next, endElapsedSeconds: end })) applyWorldDeltaOperation(next, operation);
  next.truth.elapsedSeconds = end;
  return next;
}

describe("authored periodic condition boundaries", () => {
  it("keeps outcomes independent of step size, including clamped effects with opposing directions", () => {
    const f = fixture(), source = f.world.initialState;
    source.truth.meters["health:keeper"]!.current = 19;
    source.truth.mechanics.conditionProfiles.healing = { ...source.truth.mechanics.conditionProfiles.burning!,
      id: "healing", recurringImpactProfileId: "recovery", recurringIntervalSeconds: 5 };
    source.truth.conditions.healing = { ...source.truth.conditions.burning!, id: "healing", conditionProfileId: "healing", nextImpactAtElapsedSeconds: 5 };
    const direct = advance(source, 25);
    let partitioned = source;
    for (const end of [1, 5, 6, 10, 13, 15, 20, 25]) partitioned = advance(partitioned, end);
    expect(partitioned.truth).toEqual(direct.truth);
    expect(partitioned.truth.conditions).toEqual({});
    expect(partitioned.truth.meters["health:keeper"]!.current).toBe(20);
    const merged = mergeCondition([source.truth.conditions.burning!], {
      ...source.truth.conditions.burning!, nextImpactAtElapsedSeconds: 19, expiresAtElapsedSeconds: 50 });
    expect(merged.condition.nextImpactAtElapsedSeconds).toBe(10);
    expect(merged.condition.expiresAtElapsedSeconds).toBe(50);
  });
  it("binds even a fully clamped impact to the meter it read and refuses to pass its earlier boundary", () => {
    const f = fixture(), state = f.world.initialState;
    state.truth.mechanics.conditionProfiles.burning!.recurringImpactProfileId = "recovery";
    state.truth.meters["health:keeper"]!.current = 20;
    const resources = worldResources(state, f.world), adjudication = { records: [], evidence: [], calls: [] };
    expect(nextWorldClockBoundary(state)).toBe(10);
    expect(() => createWorldEventCandidate(state, f.world, resources, [], adjudication, 20)).toThrow("earlier canonical");
    const event = createWorldEventCandidate(state, f.world, resources, [], adjudication, 10);
    expect(event.clockEffects.map(operation => operation.kind)).toEqual(["set_condition"]);
    expect(event.reads).toHaveProperty("meter:health:keeper");
    const edited = structuredClone(state); edited.truth.meters["health:keeper"]!.current = 19;
    expect(() => commitWorldEvent(edited, f.world, resources, event, { earliestPendingSeconds: 10, receipts: new Map() })).toThrow("stale world read");
    state.truth.mechanics.conditionProfiles.burning!.recurringIntervalSeconds = null;
    expect(() => validateSimulationState(state, false)).toThrow("invalid condition profile");
  });
  it("commits exact clock effects through SimulationEngine and survives restart and replay without model polling", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig);
    let engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents(), calls = f.configured.transport.mock.calls.length;
    const initialHealth = boot.truth.meters["health:keeper"]!.current;
    const roster = Object.fromEntries(Object.keys(f.roster).map(agentId => [agentId,
      { kind: "idle" as const, agentId, reason: "explicit" as const }]));
    let state = boot;
    for (const at of [10, 20, 25]) {
      const result = await engine.step(roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] });
      state = result.state;
      expect(state.truth.elapsedSeconds).toBe(at);
      expect(result.committed.actions).toEqual([]);
      expect(result.committed.temporalBoundary.dueConditionIds).toEqual(["burning"]);
      expect(state.truth.meters["health:keeper"]!.current).toBe(initialHealth - (at === 10 ? 2 : 4));
      expect(result.committed.operations.some(operation => operation.kind === (at === 25 ? "remove_condition" : "adjust_meter"))).toBe(true);
      expect(replaySimulationState(state)).toEqual(state);
      expect(f.configured.transport).toHaveBeenCalledTimes(calls);
      engine = new SimulationEngine(f.world, algorithm, JSON.parse(JSON.stringify(state)));
    }
    expect(state.truth.conditions).toEqual({});
  });
});
