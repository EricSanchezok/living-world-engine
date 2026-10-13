import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { readDecisionEventState } from "../runtime-state";

describe("world branch requirements at compilation", () => {
  it.each([
    ["completion", true], ["completion", false], ["acknowledgement", true], ["acknowledgement", false],
  ] as const)("performs one targeted repair for %s before admitting a program (repair succeeds: %s)", async (fault, repair) => {
    const f = nativeProgramFixture(), original = f.configured.transport.getMockImplementation()!;
    const finite = structuredClone(f.rule.timing); let creations = 0;
    f.configured.transport.mockImplementation(async (url, init) => {
      if (String(init?.body).includes("You compile authored world sources")) {
        creations++;
        const invalid = !repair || creations === 1;
        if (fault === "completion") f.rule.timing = invalid
          ? { profileId: "ongoing-action", basis: { kind: "profile" }, completionPredicateId: null } : finite;
        else f.rule.branches[0]!.acknowledgement = invalid ? "observed-outcome" : "attempted";
      }
      return original(url, init);
    });
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents(), control = readDecisionEventState(boot.executionState!, boot);
    expect(creations).toBe(2); expect(boot.truth).toEqual(f.world.initialState.truth);
    expect(replaySimulationState(boot)).toEqual(boot);
    if (!repair) {
      expect(control.pending[0]!.bound).toBeNull();
      expect(control.pending[0]!.failure).toContain(fault === "completion" ? "declared completion predicate" : "committed observation to its actor");
      expect(control.failures.some(failure => failure.recoverable)).toBe(true);
    } else {
      expect(control.pending[0]!.failure).toBeNull();
      const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
      expect(result.state.truth.elapsedSeconds).toBe(5);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    }
  });
});
