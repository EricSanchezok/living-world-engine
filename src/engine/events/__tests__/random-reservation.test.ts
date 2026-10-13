import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { readDecisionEventState, restoreOwnerPrograms } from "../runtime-state";
import { restoreDecisionEventStep } from "../journal";
import { replayDecisionEventStep } from "../canonical";
import { quantityId } from "../../runtime/runtime-id";
import { historyReplayBaseHash } from "../../runtime/history-replay";

function fixture() {
  const options: { worldVerdict: "yes" | "unknown" } = { worldVerdict: "yes" };
  const f = nativeProgramFixture(options);
  f.world.randomDistributions = [{ id: "gift-size", description: "An offered gift uses one or two stones with equal chance.",
    steps: [{ id: "amount", count: 1, outcomes: [1, 2], aggregate: "first", when: null }] }];
  f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Spend 5 seconds giving the traveler an authored randomly sized gift." } as typeof f.program.nodes[number];
  f.rule.random = [{ id: "gift", distributionId: "gift-size", purpose: "Choose the offered gift amount." }];
  f.rule.reads.push("random:{actor}:gift"); f.rule.sourceIds.push("mechanics"); f.rule.writes.push("quantities");
  f.rule.branches[0]!.mechanics = [{ id: "gift", packageId: "core-resolution", ruleId: "transfer-quantity", input: {
    definitionId: "spirit-stone", fromHolderId: { $expression: { kind: "parameter", name: "actor" } },
    toHolderId: { $expression: { kind: "parameter", name: "recipient" } },
    amountSource: { kind: "random_result", requestId: { $expression: { kind: "read", resource: "random:{actor}:gift", path: ["requestId"] } }, stepId: "amount" },
  } }];
  return { ...f, options };
}

describe("durable randomness through SimulationEngine", () => {
  it("closes a fixed draw with blocked receipts when its combined effects overdraw a quantity", async () => {
    const f = fixture(), holder = quantityId(f.world.initialState.worldHash, "spirit-stone", "keeper");
    f.world.initialState.truth.quantities[holder]!.amount = 3;
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    f.world.randomDistributions[0]!.steps[0]!.outcomes = [2, 2];
    f.rule.branches[0]!.mechanics.push({ ...structuredClone(f.rule.branches[0]!.mechanics[0]!), id: "second-gift" });
    await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig), engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    const reserved = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const result = await new SimulationEngine(f.world, algorithm, reserved.state).step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] });
    expect(result.state.truth.quantities).toEqual(boot.truth.quantities);
    expect(result.state.truth.rng).toEqual(reserved.state.truth.rng);
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(readDecisionEventState(result.state.executionState!, result.state).randomReservation).toBeNull();
    expect(result.committed.decisionEvent!.modelAudits.some(audit => audit.role === "creation")).toBe(false);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it.each(["yes", "unknown"] as const)("persists the draw before a %s adjudication and settles it exactly once after restart", async verdict => {
    const f = fixture(); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig);
    const engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    const reserved = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const control = readDecisionEventState(reserved.state.executionState!, reserved.state);
    expect(control.randomReservation).not.toBeNull();
    expect(reserved.state.truth.elapsedSeconds).toBe(0);
    expect(reserved.state.truth.rng.draws).toBeGreaterThan(boot.truth.rng.draws);
    expect(reserved.committed.randomResults).toHaveLength(1);
    expect(reserved.committed.actions).toEqual([]);
    const drawProof = restoreDecisionEventStep(boot, reserved.committed.decisionEvent!);
    expect(drawProof.event).toBeNull();
    expect(drawProof.decisions.map(use => use.batch)).toContainEqual(control.randomReservation!.commitment.plan.batch);
    expect(replaySimulationState(reserved.state)).toEqual(reserved.state);
    f.options.worldVerdict = verdict;
    const restarted = new SimulationEngine(f.world, algorithm, reserved.state);
    const result = await restarted.step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(5);
    expect(result.state.truth.rng).toEqual(reserved.state.truth.rng);
    expect(result.committed.randomResults).toEqual([]);
    expect(readDecisionEventState(result.state.executionState!, result.state).randomReservation).toBeNull();
    const holder = quantityId(boot.worldHash, "spirit-stone", "keeper");
    if (verdict === "yes") expect(result.state.truth.quantities[holder]!.amount).toBeLessThan(boot.truth.quantities[holder]!.amount);
    else {
      expect(result.state.truth.quantities).toEqual(boot.truth.quantities);
      expect(result.committed.outcomes[0]!.status).toBe("blocked");
      const instance = restoreOwnerPrograms(readDecisionEventState(result.state.executionState!, result.state), "keeper")[0]!;
      expect(instance.status).toBe("needs-expansion");
    }
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const forged = structuredClone(reserved.committed);
    forged.decisionEvent!.decisions = [];
    expect(() => replayDecisionEventStep(boot, forged)).toThrow();
  });
  it("retains the reservation across a transport failure without revising or drawing new stakes", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig);
    const engine = new SimulationEngine(f.world, algorithm); await engine.bootstrapAgents();
    const reserved = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const transport = f.configured.transport.getMockImplementation()!;
    f.configured.transport.mockImplementation(async () => { throw new Error("simulated offline transport"); });
    await expect(engine.step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] })).rejects.toThrow();
    expect(engine.snapshot).toEqual(reserved.state);
    f.configured.transport.mockImplementation(transport);
    const result = await new SimulationEngine(f.world, algorithm, reserved.state).step(f.roster, {
      expectedRevision: 1, trigger: "manual", externalActions: [] });
    expect(result.state.truth.rng).toEqual(reserved.state.truth.rng);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
