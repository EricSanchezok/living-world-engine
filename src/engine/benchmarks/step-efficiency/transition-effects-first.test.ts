import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { replaySimulationState } from "../../runtime/transaction";
import { evaluateCommittedBehaviorOracle } from "./behavior-oracle";
import { runConditionalCompletionScenario } from "./conditional-scenario";
import { transitionEvidenceRequest } from "./transition-evidence-codec";
import { transitionEffectsFirst } from "./transition-effects-first";

it.each(["continuing", "arrived", "invalid"] as const)("preserves actual %s inputs, schema language and complete output while placing effects first", async (scenario) => {
  const world = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
    const base = transitionEvidenceRequest(request), candidate = transitionEffectsFirst(base);
    expect(candidate.context).toBe(base.context);
    expect(candidate.schema).toBe(base.schema);
    expect(candidate.preprocessOutput).toBe(base.preprocessOutput);
    expect(contentHash(candidate.wireJsonSchema)).toBe(contentHash(base.wireJsonSchema));
    expect(Object.keys(candidate.wireJsonSchema!.properties as object)).toEqual(["operations", "mechanicInvocations", "events", "outcomes", "decisionRequests"]);
    expect(JSON.stringify(candidate.wireJsonSchema)).not.toBe(JSON.stringify(base.wireJsonSchema));
    expect(candidate.userPrompt).toContain("does not invent writes from an outcome summary");
    expect(() => transitionEffectsFirst(candidate)).toThrow("drift");
    expect(() => transitionEffectsFirst({ ...base, wireJsonSchema: z.toJSONSchema(z.object({ wrong: z.string() })) })).toThrow("complete transition");
    return fallback();
  }, true);
  expect(evaluateCommittedBehaviorOracle({ source: world.source, action: world.action, checkpoint: world.result.state, oracle: world.oracle }).verdict).toBe("passed");
  expect(contentHash(replaySimulationState(world.result.state).truth)).toBe(contentHash(world.result.state.truth));
});
