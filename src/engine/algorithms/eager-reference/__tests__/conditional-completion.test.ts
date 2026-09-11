import { describe, expect, it } from "vitest";
import { contentHash } from "../../../models/model-audit";
import { replaySimulationState } from "../../../runtime/transaction";
import { evaluateCommittedBehaviorOracle } from "../../../benchmarks/step-efficiency/behavior-oracle";
import { runConditionalCompletionScenario } from "../../../benchmarks/step-efficiency/conditional-scenario";
import { conditionalCompletionPrompt } from "../../../benchmarks/step-efficiency/conditional-completion-prompt";

describe("conditional completion through eager execution and the committer", () => {
  it.each(["continuing", "arrived", "invalid", "false-success"] as const)("verifies goal work %s without fabricating a continuation condition", async (scenario) => {
    const { source, result, action, oracle } = await runConditionalCompletionScenario(scenario, undefined, false, "goal");
    const activity = Object.values(result.state.truth.activities).find((entry) => entry.sourceActionId === action.id)!;
    if (activity.status === "queued" || activity.status === "ready") throw new Error("goal Activity did not start");
    expect(activity.plan).toMatchObject({ mode: "goal", completionAtSeconds: null, continuationAssertions: [] });
    expect(activity.status).toBe(scenario === "continuing" ? "active" : scenario === "invalid" ? "blocked" : "completed");
    expect(activity.sourceAction.rawText).toBe(action.rawText);
    expect(result.state.truth.placements.player).toBe(scenario === "arrived" ? "gate" : "courtyard");
    const verdict = evaluateCommittedBehaviorOracle({ source, action, checkpoint: result.state, oracle });
    expect(verdict.verdict).toBe(scenario === "false-success" ? "failed" : "passed");
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it.each(["continuing", "arrived", "invalid", "false-success"] as const)("verifies %s against actual state", async (scenario) => {
    const { source, result, action, oracle } = await runConditionalCompletionScenario(scenario);
    const activity = Object.values(result.state.truth.activities).find((entry) => entry.sourceActionId === action.id)!;
    expect(activity.status).toBe(scenario === "continuing" ? "active" : scenario === "invalid" ? "blocked" : "completed");
    expect(result.state.truth.placements.player).toBe(scenario === "arrived" ? "gate" : "courtyard");
    if (scenario === "arrived") {
      expect(activity).toMatchObject({ completionAtSeconds: result.state.truth.elapsedSeconds, nextBoundaryAtSeconds: null });
      expect(result.committed.activityDispositions.some((entry) => entry.activityId === activity.id && entry.kind === "block")).toBe(false);
    }
    const verdict = evaluateCommittedBehaviorOracle({ source, action, checkpoint: result.state, oracle });
    expect(verdict.verdict).toBe(scenario === "false-success" ? "failed" : "passed");
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it("freezes reproducible model contexts with independent authored checkpoint expectations", async () => {
    for (const scenario of ["continuing", "arrived", "invalid"] as const) {
      const run = async () => {
        const contextHashes: string[] = [];
        const world = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
        contextHashes.push(contentHash({ system: request.system, userPrompt: request.userPrompt, context: request.context }));
        expect(request.userPrompt).toContain("Goal and conditional Activities have no scheduled completion time");
        expect(request.userPrompt).not.toContain("When that Activity has not reached its trusted completion boundary");
        expect(conditionalCompletionPrompt(request.userPrompt)).toContain("no pre-scheduled completion time");
        return fallback();
      }, true);
        return { ...world, contextHashes };
      };
      const first = await run(), repeat = await run();
      expect(contentHash(first.source)).toBe(contentHash(repeat.source));
      // A world write legitimately adds a distinct global reconciliation pass.
      expect(first.contextHashes).toHaveLength(scenario === "continuing" ? 1 : 2);
      expect(first.contextHashes).toEqual(repeat.contextHashes);
      expect(evaluateCommittedBehaviorOracle({ source: first.source, action: first.action, checkpoint: first.result.state, oracle: first.oracle }).verdict).toBe("passed");
      expect(Object.keys(first.oracle.branches)).toEqual([scenario === "arrived" ? "succeeded" : scenario === "invalid" ? "blocked" : "continuing"]);
    }
  });
});
