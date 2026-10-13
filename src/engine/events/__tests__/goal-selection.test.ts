import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm } from "../algorithm";
import { PROGRAM_GOAL_SELECTION_HASH, programGoalSelection } from "../goal-selection";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import { privateProgramResources } from "../../programs/private-resources";
import { ProgramLibrary } from "../../programs/library";

describe("canonical private goal selection", () => {
  it("requires the actual goal decision even when generated-program evidence remains valid", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    expect(replaySimulationState(boot)).toEqual(boot);
    const forged = structuredClone(boot);
    forged.bootstrapDecisionEvent!.decisions = forged.bootstrapDecisionEvent!.decisions.filter(use => use.batch.programHash !== PROGRAM_GOAL_SELECTION_HASH);
    expect(() => validateSimulationState(forged, false, true)).toThrow("actual goal decision");
  });
  it("reconstructs ordered active goals from the owner's complete private state", () => {
    const f = nativeProgramFixture(), agent = f.world.initialState.agents.keeper!;
    const perspective = projectAgentPerspective(f.world.initialState, agent), resources = privateProgramResources(perspective).resources;
    const first = programGoalSelection(agent, perspective, resources, [], undefined, new ProgramLibrary(), 0);
    expect(first.goals.map(value => value.id)).toEqual(["guard-gate", "understand-traveler"]);
    expect(Object.keys(first.batch.questions.goal!.criteria)).toEqual(["g0", "g1", "wait"]);
    expect(JSON.stringify(first.batch)).not.toContain("key-is-authentic");
    agent.character.goals["guard-gate"]!.status = "completed";
    const next = programGoalSelection(agent, projectAgentPerspective(f.world.initialState, agent), resources, [], undefined, new ProgramLibrary(), 0);
    expect(next.goals.map(value => value.id)).toEqual(["understand-traveler"]);
    expect(Object.keys(next.batch.questions.goal!.criteria)).toEqual(["g0", "wait"]);
  });
});
