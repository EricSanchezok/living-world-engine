import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { readDecisionEventState, restoreOwnerPrograms } from "../runtime-state";

function fixture(finish: boolean) {
  const f = nativeProgramFixture();
  f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Keep watch over the traveler until relieved.", speech: { kind: "none" } } as typeof f.program.nodes[number];
  f.rule.timing = { profileId: "ongoing-action", basis: { kind: "profile" }, completionPredicateId: finish ? "finished" : null };
  f.rule.branches[0]!.outcome = "partial"; f.rule.branches[0]!.deliveries = [];
  if (finish) {
    f.rule.reads.push("clock");
    f.rule.predicates.push({ id: "finished", description: "The declared watch has reached its end", sourceIds: ["world"], reads: ["clock"], unknown: "wait",
      test: { kind: "mechanical", operator: "gte", left: { kind: "read", resource: "clock", path: [] }, right: { kind: "literal", value: 60 } } });
    f.rule.branches[0]!.when.push({ predicateId: "finished", equals: "no" });
    f.rule.branches.push({ ...structuredClone(f.rule.branches[0]!), id: "finished", outcome: "succeeded",
      when: [{ predicateId: "reachable", equals: "yes" }, { predicateId: "finished", equals: "yes" }] });
  }
  return f;
}

describe("ongoing program activities", () => {
  it("retains an issued attempt and capacity across checkpoints, restart and unchanged cached decisions", async () => {
    const f = fixture(false); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig), engine = new SimulationEngine(f.world, algorithm);
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const before = readDecisionEventState(first.state.executionState!, first.state), activity = before.activities[0]!;
    expect(activity).toMatchObject({ status: "active", checkpointCount: 1, startedAtSeconds: 0, dueAtSeconds: 120 });
    expect(before.pending).toHaveLength(1);
    expect(before.receipts[0]!.programReceipts[0]!.status).toBe("continuing");
    expect(restoreOwnerPrograms(before, "keeper")[0]!.position[0]!.issued).toBe(true);
    const restart = new SimulationEngine(f.world, algorithm, first.state);
    const second = await restart.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(second.state.truth.elapsedSeconds).toBe(120);
    const calls = f.configured.transport.mock.calls.length;
    const third = await restart.step(f.roster, { expectedRevision: second.state.revision, trigger: "manual", externalActions: [] });
    expect(third.state.truth.elapsedSeconds).toBe(180);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    const final = readDecisionEventState(third.state.executionState!, third.state);
    expect(final.activities[0]).toMatchObject({ id: activity.id, status: "active", checkpointCount: 3, dueAtSeconds: 240 });
    expect(final.pending[0]!.attempt).toEqual(before.pending[0]!.attempt);
    expect(final.agents.keeper!.instances).toHaveLength(1);
    expect(replaySimulationState(third.state)).toEqual(third.state);
  });
  it("releases an interruptible ongoing reservation when its controller is revoked", async () => {
    const f = fixture(false); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const roster = { ...f.roster, keeper: { kind: "idle" as const, agentId: "keeper", reason: "explicit" as const } };
    const stopped = await engine.step(roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const control = readDecisionEventState(stopped.state.executionState!, stopped.state);
    expect(stopped.state.truth.elapsedSeconds).toBe(60);
    expect(control.activities[0]).toMatchObject({ status: "cancelled", endedAtSeconds: 60, checkpointCount: 1 });
    expect(control.pending).toEqual([]);
    expect(restoreOwnerPrograms(control, "keeper")[0]!.status).toBe("interrupted");
    expect(replaySimulationState(stopped.state)).toEqual(stopped.state);
  });
  it("finishes only on its declared condition and releases capacity without completing its long-term goal", async () => {
    const f = fixture(true); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const final = await engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const control = readDecisionEventState(final.state.executionState!, final.state);
    expect(control.activities[0]).toMatchObject({ status: "completed", checkpointCount: 1, endedAtSeconds: 120 });
    expect(control.pending).toEqual([]);
    expect(restoreOwnerPrograms(control, "keeper")[0]!.completion.executionEnded).toBe(true);
    expect(final.state.agents.keeper!.character.goals["guard-gate"]!.status).toBe("active");
    expect(replaySimulationState(final.state)).toEqual(final.state);
  });
});
