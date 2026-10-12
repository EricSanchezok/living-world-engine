import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm, decisionEventAlgorithmRef, WorldQuiescentError } from "../algorithm";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { restoreOwnerPrograms, readDecisionEventState } from "../runtime-state";
import type { PolicyBinding } from "../../runtime/execution";
import { contentHash } from "../../models/model-audit";


describe("native event runtime through SimulationEngine", () => {
  it("exposes every ordered debug stage around native model work and canonical validation", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const entered: number[] = [], completed: number[] = [];
    await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] }, {
      workloadId: "native-stages", batchId: "native-stages", stageHooks: { enabled: true,
        before: async stage => { entered.push(stage.index); }, after: async stage => { completed.push(stage.index); },
        failed: () => { throw new Error("unexpected stage failure"); } },
    });
    expect(entered).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(completed).toEqual(entered);
  });
  it("registers a pinned algorithm, commits actual speech, and replays/restarts without duplicate effects", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const registry = registerBuiltinAlgorithms();
    const algorithm = registry.create(decisionEventAlgorithmRef(nativeProgramTestConfig), { provider: f.configured.gateway });
    const engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    expect(boot.truth.elapsedSeconds).toBe(0); expect(boot.revision).toBe(0);
    expect(boot.bootstrapAgentCommits).toEqual([]); expect(boot.bootstrapDecisionEvent).toBeDefined();
    expect(boot.bootstrapDecisionEvent!.control.coverage.find(row => row.ownerId === "keeper")!.status).toBe("waiting");
    validateSimulationState(boot, false, true);
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(5); expect(result.state.step).toBe(1); expect(result.state.revision).toBe(1);
    expect(result.committed.actions).toHaveLength(1); expect(result.committed.observations.map(packet => packet.observerId)).toContain("player");
    const control = readDecisionEventState(result.state.executionState!, result.state);
    expect(control.pending).toHaveLength(0); expect(control.receipts).toHaveLength(1);
    expect(restoreOwnerPrograms(control, "keeper")[0]!.completion).toMatchObject({ executionEnded: true, goals: {} });
    expect(f.configured.transport.mock.calls.every(call => !String(call[1]?.body).includes("causal-verifier"))).toBe(true);
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const restarted = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig), JSON.parse(JSON.stringify(result.state)));
    expect(restarted.snapshot.truth.events).toEqual(result.state.truth.events);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("rejects edited private verdicts even if envelope hashes are recomputed", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const tampered = structuredClone(boot);
    const entry = tampered.bootstrapDecisionEvent!.control.agents.keeper!.instances[0]!.snapshot;
    const predicate = entry.events.find(event => event.kind === "predicate" && event.reason === "goal");
    if (!predicate || predicate.kind !== "predicate") throw new Error("missing test predicate");
    predicate.verdict = "yes";
    entry.hash = contentHash(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "hash")));
    const control = tampered.bootstrapDecisionEvent!.control;
    control.hash = contentHash(Object.fromEntries(Object.entries(control).filter(([key]) => key !== "hash")));
    tampered.executionState!.data = JSON.parse(JSON.stringify(control));
    expect(() => validateSimulationState(tampered, false, true)).toThrow("predicate verdict");
  });
  it("commits a controller interruption without advancing world time and then sleeps without model work", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const roster: Record<string, PolicyBinding> = { ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
    const count = f.configured.transport.mock.calls.length;
    const result = await engine.step(roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.revision).toBe(1); expect(result.state.step).toBe(0); expect(result.state.truth.elapsedSeconds).toBe(0);
    expect(result.committed.decisionEvent!.event).toBeNull(); expect(replaySimulationState(result.state)).toEqual(result.state);
    await expect(engine.step(roster, { expectedRevision: 1, trigger: "manual", externalActions: [] })).rejects.toBeInstanceOf(WorldQuiescentError);
    expect(f.configured.transport).toHaveBeenCalledTimes(count);
  });
  it("takes a natural-language player submission through authored speech, world adjudication and canonical delivery", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const heard = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const keeperRef = Object.values(heard.state.agents.player!.bindings).find(binding => binding.canonicalEntityIds[0] === "keeper")!.localEntityId;
    const roster: Record<string, PolicyBinding> = { ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
    const result = await engine.step(roster, { expectedRevision: 1, trigger: "participant_action", externalActions: [{
      agentId: "player", submissionId: "player-speech", rawText: 'Spend 5 seconds saying "Hello keeper" to the keeper.',
      goal: "Greet the keeper", means: null, targetIds: [keeperRef],
    }] });
    expect(result.state.truth.elapsedSeconds).toBe(10); expect(result.committed.actions[0]!.actorId).toBe("player");
    expect(result.committed.decisionEvent!.event!.deliveries).toContainEqual({
      attemptId: result.committed.actions[0]!.id, recipientEntityId: "keeper", kind: "speech", text: "Hello keeper",
    });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
