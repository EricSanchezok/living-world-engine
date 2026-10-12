import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { DecisionEventAlgorithm, SCRIPT_EVENT_CONFIG } from "../algorithm";
import { applyDecisionEventBootstrap } from "../canonical";
import { agentEventModels } from "../model-bindings";
import { sealDecisionEventState } from "../runtime-state";

describe("script and instance model capability bindings", () => {
  it("inherits separate world and Agent profiles and preserves them through replay", async () => {
    const f = nativeProgramFixture();
    Object.assign(f.world.initialState.agents.keeper!.modelProfiles, { decision: "decision-deepseek", creation: "world-test" });
    f.world.historyBaseHash = historyReplayBaseHash(f.world.initialState);
    await f.configured.registry.capture();
    const algorithm = new DecisionEventAlgorithm(f.configured.gateway), engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents(), proof = boot.bootstrapDecisionEvent!;
    expect(proof.control.models).toEqual(f.world.modelProfiles);
    expect(proof.control.modelOverrides).toEqual({ decision: null, creation: null, fallback: null });
    expect(proof.producer.manifestHash).toBe(algorithm.manifest.hash);
    expect(proof.modelAudits.filter(audit => audit.subjectId === "keeper" && audit.role === "decision").every(audit => audit.profileId === "decision-deepseek")).toBe(true);
    expect(proof.modelAudits).toContainEqual(expect.objectContaining({ subjectId: "keeper", role: "creation", profileId: "world-test" }));
    expect(proof.modelAudits).toContainEqual(expect.objectContaining({ subjectId: "world", role: "creation", profileId: "creation-deepseek" }));
    expect(replaySimulationState(boot)).toEqual(boot);
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const calls = f.configured.transport.mock.calls.length;
    const recovered = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway), JSON.parse(JSON.stringify(result.state)));
    expect(recovered.snapshot).toEqual(result.state);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("pins an experiment override for decisions while creation retains each script profile", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const config = { ...SCRIPT_EVENT_CONFIG, decision: "world-test" };
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, config));
    const boot = await engine.bootstrapAgents(), control = boot.bootstrapDecisionEvent!.control;
    expect(control.models).toMatchObject({ decision: "world-test", creation: "creation-deepseek", fallback: "decision-deepseek" });
    expect(agentEventModels(boot, control, "keeper")).toEqual(control.models);
    expect(boot.bootstrapDecisionEvent!.modelAudits.filter(audit => audit.role === "decision").every(audit => audit.profileId === "world-test")).toBe(true);
    const forged = structuredClone(boot.bootstrapDecisionEvent!);
    forged.control = sealDecisionEventState({ ...forged.control, modelOverrides: { ...forged.control.modelOverrides, creation: "world-test" } });
    expect(() => applyDecisionEventBootstrap(f.world.initialState, forged)).toThrow("model configuration differs from its producer");
  });
  it("explicit native test overrides remain pinned rather than silently inheriting changed defaults", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const state = await engine.bootstrapAgents();
    expect(state.bootstrapDecisionEvent!.control.models).toEqual({ decision: "world-test", creation: "world-test", fallback: "world-test" });
    expect(replaySimulationState(state)).toEqual(state);
  });
});
