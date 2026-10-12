import { describe, expect, it } from "vitest";
import { nativeProgramFixture } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { contentHash } from "../../models/model-audit";
import type { AgentState } from "../../contracts/model";
import type { JsonObject } from "../../runtime/json";
import { DecisionEventAlgorithm } from "../algorithm";
import { restoreDecisionEventStep } from "../journal";
import { commitWorldEvent } from "../kernel";
import { worldResources } from "../resources";
import { readDecisionEventState } from "../runtime-state";

function fixture() {
  const f = nativeProgramFixture();
  f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Spend 5 seconds constructing a note holder.", speech: { kind: "none" } } as typeof f.program.nodes[number];
  f.rule.description = "Construct and label a note holder.";
  f.rule.writes = ["entities", "placements", "facts"];
  const branch = f.rule.branches[0]!;
  branch.deliveries = [];
  branch.effects = [
    { kind: "create_entity", fields: { entity: { id: "new-holder", kind: "item", name: "Note holder", description: "An assembled holder.", lifecycle: "active", createdAtStep: 1 }, placementId: "courtyard" } },
    { kind: "set_fact", fields: { fact: { id: "holder-ready", subjectId: "new-holder", predicate: "ready", value: { kind: "boolean", value: true }, description: "The holder is assembled.", access: { kind: "public" } } } },
  ];
  return f;
}

describe("open entity and Agent expansion", () => {
  it("creates and references an entity in one canonical event, retains absence reads and replays exactly once", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway), engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.truth.entities["new-holder"]!.createdAtStep).toBe(1);
    expect(result.state.truth.facts["holder-ready"]!.subjectId).toBe("new-holder");
    const proof = restoreDecisionEventStep(boot, result.committed.decisionEvent!), event = proof.event!;
    expect(event.reads.entities).toBeDefined(); expect(event.reads["entity:new-holder"]).toBeUndefined();
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const duplicate = commitWorldEvent(result.state, proof.authority, worldResources(result.state, proof.authority), event,
      { earliestPendingSeconds: event.atSeconds, receipts: new Map(proof.finalControl.receipts.map(receipt => [receipt.candidateId, receipt])) });
    expect(duplicate.replayed).toBe(true); expect(duplicate.state).toEqual(result.state);
    const concurrent = structuredClone(boot);
    concurrent.executionState = { producerHash: algorithm.manifest.hash, data: proof.preparedControl as unknown as JsonObject };
    concurrent.truth.entities["new-holder"] = result.state.truth.entities["new-holder"]!;
    concurrent.truth.placements["new-holder"] = "courtyard";
    expect(() => commitWorldEvent(concurrent, proof.authority, proof.preparedControl.worldResources, event,
      { earliestPendingSeconds: event.atSeconds, receipts: new Map() })).toThrow("stale world read entities");
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });

  it("retains source-owner decision evidence when the same event removes that Agent", async () => {
    const f = fixture(); f.rule.writes = ["agentRoster"];
    f.rule.branches[0]!.effects = [{ kind: "remove_agent", fields: { agentId: "keeper" } }];
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway));
    await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.agents.keeper).toBeUndefined();
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["repair", "failed"] as const)("handles a dangling entity reference with one targeted creation repair: %s", async mode => {
    const f = fixture(), original = f.configured.transport.getMockImplementation()!; let creations = 0;
    f.configured.transport.mockImplementation(async (url, init) => {
      if (String(init?.body).includes("You compile authored world sources")) {
        creations += 1;
        (f.rule.branches[0]!.effects[1]!.fields.fact as Record<string, unknown>).subjectId = mode === "repair" && creations === 2 ? "new-holder" : "missing-holder";
      }
      return original(url, init);
    });
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway));
    const boot = await engine.bootstrapAgents();
    expect(creations).toBe(2); expect(boot.truth).toEqual(f.world.initialState.truth);
    const control = readDecisionEventState(boot.executionState!, boot);
    if (mode === "failed") {
      expect(control.pending[0]!.failure).toContain("unavailable entity missing-holder");
      expect(control.pending[0]!.bound).toBeNull();
      expect(boot.truth.entities["new-holder"]).toBeUndefined();
    } else {
      const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
      expect(result.state.truth.facts["holder-ready"]!.subjectId).toBe("new-holder");
      expect(replaySimulationState(result.state)).toEqual(result.state);
    }
  });

  it.each([false, true])("assigns dynamic Agent model bindings in code and rejects generated configuration (override: %s)", async override => {
    const f = fixture();
    const agent: Partial<AgentState> = structuredClone(f.world.initialState.agents.keeper!);
    agent.id = "holder-caretaker"; agent.entityId = "new-holder"; agent.character!.goals = {};
    agent.bindings!.self!.canonicalEntityIds = ["new-holder"];
    if (override) agent.modelProfiles = { decision: "invented-profile", creation: "world-test", fallback: "world-test" };
    else delete agent.modelProfiles;
    f.rule.writes.push("agentRoster");
    f.rule.branches[0]!.effects.push({ kind: "create_agent", fields: { agent: JSON.parse(JSON.stringify(agent)) } });
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway));
    const boot = await engine.bootstrapAgents();
    if (override) {
      expect(boot.bootstrapDecisionEvent!.control.pending[0]!.failure).toContain("modelProfiles are engine-owned");
      expect(boot.truth.entities["new-holder"]).toBeUndefined();
      return;
    }
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const created = result.state.agents["holder-caretaker"]!;
    expect(created.modelProfiles).toEqual(f.world.modelProfiles);
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const calls = f.configured.transport.mock.calls.length;
    const recovered = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway), JSON.parse(JSON.stringify(result.state)));
    expect(contentHash(recovered.snapshot)).toBe(contentHash(result.state));
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    const next = await recovered.step({ ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
      [created.id]: { kind: "model", agentId: created.id, profiles: created.modelProfiles } },
      { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(readDecisionEventState(next.state.executionState!, next.state).agents[created.id]).toBeDefined();
    expect(next.state.truth.elapsedSeconds).toBe(result.state.truth.elapsedSeconds);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
});
