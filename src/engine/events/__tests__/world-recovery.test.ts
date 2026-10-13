import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm, WorldQuiescentError } from "../algorithm";
import { invocationAllocator, readDecisionEventState } from "../runtime-state";
import { prepareProgramWorldWork } from "../world-control";
import { toWorldRuntimeContract } from "../../runtime/world-definition";
import { quantityId } from "../../runtime/runtime-id";
import { historyReplayBaseHash } from "../../runtime/history-replay";

describe("world program recovery through the native engine", () => {
  it("repairs a jointly oversubscribed resource before any effects or private observations commit", async () => {
    const f = nativeProgramFixture({ bothActors: true });
    const holder = quantityId(f.world.initialState.worldHash, "spirit-stone", "keeper");
    f.world.initialState.truth.quantities[holder]!.amount = 3;
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Spend 5 seconds giving all available spirit stones to the traveler." } as typeof f.program.nodes[number];
    f.rule.sourceIds.push("mechanics"); f.rule.writes.push("quantities");
    f.rule.branches[0]!.mechanics = [{ id: "gift", packageId: "core-resolution", ruleId: "transfer-quantity", input: {
      definitionId: "spirit-stone", fromHolderId: "keeper", toHolderId: "player",
      amountSource: { kind: "existing_state", quantityId: holder },
    } }];
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    expect(boot.bootstrapDecisionEvent!.control.pending).toHaveLength(2);
    expect(boot.bootstrapDecisionEvent!.control.pending.map(value => ({ actor: value.attempt.actorId, failure: value.failure, at: value.atSeconds }))
      .sort((a, b) => a.actor.localeCompare(b.actor))).toEqual([{ actor: "keeper", failure: null, at: 5 }, { actor: "player", failure: null, at: 5 }]);
    const rejected = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(rejected.state.truth).toEqual(boot.truth);
    const pending = readDecisionEventState(rejected.state.executionState!, rejected.state).pending;
    expect(pending).toHaveLength(2);
    expect(pending.every(value => value.failure?.includes("insufficient quantity") && value.recovery?.disposition === "expand")).toBe(true);
    // The revised source-bound rule gives the owner permission and blocks the competing attempt.
    f.rule.predicates.push({ id: "owner", description: "Only the actual owner may transfer these stones.", reads: ["entity:{actor}"],
      sourceIds: ["world"], unknown: "wait", test: { kind: "mechanical", operator: "eq",
        left: { kind: "parameter", name: "actor" }, right: { kind: "literal", value: "keeper" } } });
    f.rule.branches[0]!.when.push({ predicateId: "owner", equals: "yes" });
    f.rule.branches.push({ ...structuredClone(f.rule.branches[0]!), id: "blocked", when: [{ predicateId: "owner", equals: "no" }],
      description: "The competing transfer is blocked.", acknowledgement: "observed-outcome", outcome: "blocked", effects: [], mechanics: [],
      deliveries: [{ kind: "observation", recipientParameter: "actor", text: "Your competing transfer was blocked." }] });
    const repaired = await engine.step(f.roster, { expectedRevision: rejected.state.revision, trigger: "manual", externalActions: [] });
    expect(repaired.state.truth.quantities[holder]!.amount).toBe(0);
    expect(repaired.committed.outcomes.map(value => value.status).sort()).toEqual(["blocked", "succeeded"]);
    expect(readDecisionEventState(repaired.state.executionState!, repaired.state).pending).toEqual([]);
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(repaired.state)).toEqual(repaired.state);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("retains a supported frontier and rejudges it after a coupled unsupported attempt exhausts repair", async () => {
    const f = nativeProgramFixture();
    f.rule.predicates.push({ id: "actor-allowed", description: "Only this compiled actor branch is available.", sourceIds: ["world"],
      reads: ["entity:{actor}"], unknown: "expand", test: { kind: "mechanical", operator: "eq",
        left: { kind: "parameter", name: "actor" }, right: { kind: "literal", value: "keeper" } } });
    f.rule.branches[0]!.when.push({ predicateId: "actor-allowed", equals: "yes" });
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [{ agentId: "player",
      submissionId: "coupled-unsupported", rawText: 'Spend 5 seconds calling out "Hello keeper".', goal: "Greet", means: null, targetIds: [] }] });
    const control = readDecisionEventState(first.state.executionState!, first.state);
    expect(control.pending.find(value => value.attempt.actorId === "keeper")).toMatchObject({ failure: null, atSeconds: 5 });
    const failed = control.pending.find(value => value.attempt.actorId === "player")!;
    expect(failed.failure).toContain('"evaluated":{"left":"player","right":"keeper"}');
    expect(failed.failure).toContain('"unmetConditions":[{"predicateId":"actor-allowed","equals":"yes"}]');
    const repaired = await engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const completed = await engine.step(f.roster, { expectedRevision: repaired.state.revision, trigger: "manual", externalActions: [] });
    expect(completed.state.truth.elapsedSeconds).toBe(5);
    expect(completed.committed.actions.map(action => action.actorId)).toEqual(["keeper"]);
    expect(completed.state.step).toBe(1);
    expect(readDecisionEventState(completed.state.executionState!, completed.state).pending[0]!.attempt.actorId).toBe("player");
    expect(replaySimulationState(completed.state)).toEqual(completed.state);
  });
  it("waits on actual judgment reads and ignores an unrelated world's change", async () => {
    const options = { worldVerdict: "unknown" as const };
    const f = nativeProgramFixture(options); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const control = readDecisionEventState(result.state.executionState!, result.state);
    expect(control.pending[0]!.recovery?.disposition).toBe("wait");
    expect(control.pending[0]!.recovery?.reads["entity:keeper"]).toBeDefined();
    expect(control.pending[0]!.recovery?.reads["entity:key"]).toBeUndefined();
    const calls = f.configured.transport.mock.calls.length;
    await expect(engine.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] })).rejects.toBeInstanceOf(WorldQuiescentError);
    const unrelated = structuredClone(result.state);
    unrelated.truth.entities.key!.description += " A distant change.";
    const prepared = await prepareProgramWorldWork(f.configured.gateway, toWorldRuntimeContract(f.world), unrelated, control,
      { workloadId: "unrelated", batchId: "unrelated" }, invocationAllocator(control, unrelated.revision).next);
    expect(prepared.control.pending).toEqual(control.pending);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("bypasses a rejected cached rule, revises once, and remains recoverable after a second rejection", async () => {
    const f = nativeProgramFixture({ worldVerdict: "no" }); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(first.state.truth.elapsedSeconds).toBe(0);
    const rejected = readDecisionEventState(first.state.executionState!, first.state).pending[0]!;
    expect(rejected.recovery?.disposition).toBe("expand");
    // A repaired read declaration must not reset the unchanged-input revision budget.
    f.rule.reads.push("facts");
    const second = await engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    const pending = readDecisionEventState(second.state.executionState!, second.state).pending[0]!;
    expect(pending.recovery?.revisedInputs).toHaveLength(1);
    expect(pending.bound!.program.hash).not.toBe(rejected.bound!.program.hash);
    const creations = f.configured.transport.mock.calls.filter(call => String(call[1]?.body).includes("You compile authored world sources"));
    expect(creations).toHaveLength(2);
    expect(String(creations[1]![1]?.body)).toContain("rejection");
    const calls = f.configured.transport.mock.calls.length;
    await expect(engine.step(f.roster, { expectedRevision: second.state.revision, trigger: "manual", externalActions: [] })).rejects.toBeInstanceOf(WorldQuiescentError);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
});
