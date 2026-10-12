import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { readDecisionEventState } from "../runtime-state";
import { worldProgramSources, worldResources } from "../resources";
import { admitWorldProgram } from "../world-program";
import { materializeWorldResolutions } from "../resolutions";

function fixture(mode: "automatic" | "check") {
  const f = nativeProgramFixture();
  const health = Object.values(f.world.initialState.truth.meters).find(meter => meter.entityId === "player" && meter.definitionId === "health")!;
  f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Spend 5 seconds striking at the traveler during the confrontation.", speech: { kind: "none" } } as typeof f.program.nodes[number];
  f.rule.sourceIds.push("mechanics"); f.rule.writes.push("meters", "conditions");
  f.rule.resolutions = [{ id: "strike", plan: {
    targetIds: ["player", "keeper"], goal: "Make the traveler stop", means: [{ description: "A physical strike", source: { kind: "entity", id: "keeper" } }],
    mode, difficulty: mode === "check" ? { kind: "environment", band: "easy", source: { kind: "entity", id: "player" } } : null,
    actorRatingId: null, factors: [], risk: "risky", baseEffect: "minor", visibility: "hidden",
    primaryEffect: { kind: "meter", id: "harm", targetId: "player", channel: "physical-harm", label: "Harm", description: "A glancing strike",
      sourceRefs: [{ kind: "entity", id: "keeper" }], meterId: health.id, impactProfileId: "harm", magnitude: "minor" },
    secondaryEffect: null, threatenedEffect: mode === "check" ? { kind: "condition", id: "opening", targetId: "keeper", channel: "position",
      label: "Exposed", description: "The attacker leaves an opening", sourceRefs: [{ kind: "entity", id: "keeper" }],
      conditionId: "exposed-keeper", conditionProfileId: null, durationProfileId: "brief", access: { kind: "public" } } : null,
  } }];
  f.rule.branches[0]!.resolutions = ["strike"]; f.rule.branches[0]!.deliveries = [];
  return { ...f, health };
}

describe("named world resolutions", () => {
  it.each(["automatic", "check"] as const)("derives %s effects through the real entry, trusted package and persisted replay", async mode => {
    const f = fixture(mode); await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig), engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    let result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    if (mode === "check") {
      expect(result.state.truth.elapsedSeconds).toBe(0);
      expect(result.committed.checkRequests[0]).toMatchObject({ dc: 10, modifier: 0, mode: "normal", visibility: "hidden" });
      expect(result.committed.checks).toHaveLength(1);
      const reserved = readDecisionEventState(result.state.executionState!, result.state).randomReservation!;
      expect(reserved.commitment.plan.checkRequests[0]!.id).toBe(result.committed.checkRequests[0]!.id);
      const restart = new SimulationEngine(f.world, algorithm, result.state);
      result = await restart.step(f.roster, { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
      expect(result.committed.checks).toEqual([]);
    }
    expect(result.state.truth.elapsedSeconds).toBe(5);
    expect(result.committed.resolutionPlans[0]!.mode).toBe(mode);
    const receipt = result.committed.resolutionReceipts[0]!;
    expect(receipt.settled).toBe(true);
    expect(result.committed.mechanicInvocations[0]!.ruleId).toBe("apply-receipt");
    expect(receipt.operations).toEqual(result.committed.mechanicResults[0]!.operations);
    for (const effect of receipt.effects) if (effect.intent.kind === "meter") {
      const amount = result.state.truth.mechanics.impactProfiles.harm!.amounts[effect.magnitude];
      expect(result.state.truth.meters[f.health.id]!.current).toBe(boot.truth.meters[f.health.id]!.current - amount);
    }
    expect(result.committed.observations).toEqual([]);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("rejects a foreign meter and absent stakes before drawing", () => {
    const f = fixture("check"), state = f.world.initialState;
    const plan = f.rule.resolutions[0]!.plan as Record<string, import("../../runtime/json").JsonValue>;
    const effect = plan.primaryEffect as Record<string, import("../../runtime/json").JsonValue>;
    effect.targetId = "keeper";
    const attempt = { id: "test-attempt", actorId: "keeper", actorEntityId: "keeper", intent: "Strike", utterance: null,
      targetEntityIds: ["player"], startedAtSeconds: 0, program: null };
    const bound = () => ({ program: admitWorldProgram(f.rule, worldProgramSources(f.world, state)), parameters: {
      actor: "keeper", recipient: "player", utterance: "" }, attempt });
    expect(() => materializeWorldResolutions(state, f.world, worldResources(state, f.world), bound())).toThrow("meter, target");
    effect.targetId = "player"; plan.threatenedEffect = null;
    expect(() => materializeWorldResolutions(state, f.world, worldResources(state, f.world), bound())).toThrow("failure threat");
    expect(state.truth.rng.draws).toBe(0);
  });
});
