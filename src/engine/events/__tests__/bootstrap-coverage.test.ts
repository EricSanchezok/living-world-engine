import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { applyDecisionEventBootstrap } from "../canonical";
import { programExecutionCoverage } from "../runtime-state";

describe("executable initial goal coverage", () => {
  it("compiles the actual first world frontier and persists admission before any physical advance", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents(), proof = boot.bootstrapDecisionEvent!, control = proof.control;
    expect(proof.version).toBe(3);
    expect(boot.truth).toEqual(f.world.initialState.truth);
    expect(control.worldLibrary.entries).toHaveLength(1);
    expect(control.pending[0]).toMatchObject({ atSeconds: 5, failure: null, bound: { program: { definition: { id: "ask-reachable" } } } });
    expect(control.activities[0]).toMatchObject({ status: "active", startedAtSeconds: 0, dueAtSeconds: 5 });
    expect(programExecutionCoverage(control).find(row => row.goalId === "guard-gate")!.executionStatus).toBe("running");
    expect(replaySimulationState(boot)).toEqual(boot);
    const calls = f.configured.transport.mock.calls.length;
    await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const later = f.configured.transport.mock.calls.slice(calls).map(([, init]) => String(init?.body)).join("\n");
    expect(later).not.toContain("You compile authored world sources");
    const forged = structuredClone(proof);
    forged.modelAudits = forged.modelAudits.filter(audit => !(audit.subjectId === "world" && audit.role === "creation"));
    expect(() => applyDecisionEventBootstrap(f.world.initialState, forged)).toThrow("new world program has no source-bound creation evidence");
  });
  it("does not label a compiled private plan executable when its world rule cannot compile", async () => {
    const f = nativeProgramFixture(); f.rule.timing.profileId = "missing-profile";
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents(), control = boot.bootstrapDecisionEvent!.control;
    expect(control.privateLibrary.entries).toHaveLength(1);
    expect(control.worldLibrary.entries).toHaveLength(0);
    expect(control.pending[0]!.failure).toBeTruthy();
    const row = programExecutionCoverage(control).find(row => row.goalId === "guard-gate")!;
    expect(row.executionStatus).toBe("compilation-required");
    expect(row.attempts[0]!.failure).toBeTruthy();
    expect(boot.truth.elapsedSeconds).toBe(0);
    expect(replaySimulationState(boot)).toEqual(boot);
  });
});
