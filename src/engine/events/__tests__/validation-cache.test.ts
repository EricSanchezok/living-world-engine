import { describe, expect, it, vi } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replayCommittedHistory, replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { coreResolutionRulePackage, createCoreRulePackageRegistry, RulePackageRegistry } from "../../mechanics/rule-package";
import { DecisionEventAlgorithm } from "../algorithm";

async function sample() {
  const fixture = nativeProgramFixture(); await fixture.configured.registry.capture();
  const engine = new SimulationEngine(fixture.world, new DecisionEventAlgorithm(fixture.configured.gateway, nativeProgramTestConfig));
  await engine.bootstrapAgents();
  const { state } = await engine.step(fixture.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
  return { fixture, state };
}
describe("exact native history validation reuse", () => {
  it("reuses an identical complete state while explicit replay still executes", async () => {
    const { state } = await sample(), registry = createCoreRulePackageRegistry(), resolve = vi.spyOn(registry, "resolve");
    replayCommittedHistory(state, registry);
    expect(resolve).toHaveBeenCalled(); resolve.mockClear();
    validateSimulationState(structuredClone(state), false, true, registry);
    expect(resolve).not.toHaveBeenCalled();
    expect(replaySimulationState(state, state.revision, registry)).toEqual(state);
    expect(resolve).toHaveBeenCalled();
  });
  it("does not trust a modified state, another registry or custom rules", async () => {
    const { state } = await sample(), registry = createCoreRulePackageRegistry();
    replayCommittedHistory(state, registry);
    const changed = structuredClone(state); changed.truth.elapsedSeconds++;
    expect(() => replayCommittedHistory(changed, registry)).toThrow("does not match");
    const other = createCoreRulePackageRegistry(), resolve = vi.spyOn(other, "resolve");
    replayCommittedHistory(state, other); expect(resolve).toHaveBeenCalled();
    const custom = new RulePackageRegistry([{ ...coreResolutionRulePackage }]), customResolve = vi.spyOn(custom, "resolve");
    replayCommittedHistory(state, custom); customResolve.mockClear();
    replayCommittedHistory(state, custom); expect(customResolve).toHaveBeenCalled();
  });
  it("invalidates core eligibility when a custom package is added", () => {
    const registry = createCoreRulePackageRegistry(); expect(registry.replayValidationCacheIdentity).toBe(registry);
    registry.register({ ...coreResolutionRulePackage, id: "custom" });
    expect(registry.replayValidationCacheIdentity).toBeUndefined();
  });
  it("consumes the original snapshot proof after verifying the isolated copy", async () => {
    const { fixture, state } = await sample();
    const registry = new RulePackageRegistry([{ ...coreResolutionRulePackage }]);
    const algorithm = new DecisionEventAlgorithm(fixture.configured.gateway, nativeProgramTestConfig, registry);
    const engine = new SimulationEngine(fixture.world, algorithm, state), snapshot = engine.snapshot;
    const resolve = vi.spyOn(registry, "resolve");
    new SimulationEngine(fixture.world, algorithm, snapshot); expect(resolve).not.toHaveBeenCalled();
    const changed = engine.snapshot; changed.truth.elapsedSeconds++;
    expect(() => new SimulationEngine(fixture.world, algorithm, changed)).toThrow("does not match");
  });
});
