import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { runConditionalCompletionScenario } from "./conditional-scenario";

it.each(["continuing", "arrived"] as const)("distinguishes provisional receipt grade from actual %s goal settlement", async scenario => {
  let captured = 0;
  const { source, result } = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
    const context = request.context as { task: { stage: string }; state: { resolutionReceipts: Array<{ settled: boolean; outcome: string }> } };
    expect(context.task.stage).toBe("transition");
    expect(context.state.resolutionReceipts).toHaveLength(1);
    expect(context.state.resolutionReceipts[0]).toMatchObject({ outcome: "full", settled: true });
    expect(request.system).toContain("not evidence that the action has finished");
    expect(request.system).toContain("continuing defers receipt effects");
    expect(request.system).toContain("validated outcomes");
    expect(request.userPrompt).toContain("they do not certify action completion");
    const before = contentHash(context), generated = await fallback();
    expect(contentHash(context)).toBe(before); captured++;
    return generated;
  }, true, "goal");
  expect(captured).toBeGreaterThan(0);
  const receipt = result.committed.resolutionReceipts[0]!;
  expect(receipt.outcome).toBe("full");
  expect(receipt.settled).toBe(scenario === "arrived");
  expect(result.committed.outcomes[0]!.status).toBe(scenario === "arrived" ? "succeeded" : "continuing");
  expect(source.truth.placements.player).toBe("courtyard");
  expect(result.committed.operations.some(operation => operation.kind === "place_entity" && operation.entityId === "player"))
    .toBe(scenario === "arrived");
});
