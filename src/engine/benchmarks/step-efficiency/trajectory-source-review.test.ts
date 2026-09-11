import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { runConditionalCompletionScenario } from "./conditional-scenario";
import { assertTrajectorySourceReview } from "./trajectory-source-review";

it("requires every original action and exact before/after binding before continuing a trajectory", async () => {
  const world = await runConditionalCompletionScenario("arrived", undefined, true);
  const binding = { step: world.result.state.step, sourceStateHash: contentHash(world.source), checkpointStateHash: contentHash(world.result.state), actions: [world.action], evidence: { checkpoint: world.result.state } };
  const value = { method: "source-bound-assistant-review", step: binding.step, sourceStateHash: binding.sourceStateHash, checkpointStateHash: binding.checkpointStateHash,
    cases: [{ actionId: world.action.id, actionHash: contentHash(world.action), verdict: "pass", reason: "Original arrival action is supported by the committed player placement.", evidencePaths: ["/checkpoint/truth/placements/player"] }] };
  expect(assertTrajectorySourceReview(value, binding).cases).toHaveLength(1);
  expect(() => assertTrajectorySourceReview({ ...value, cases: [] }, binding)).toThrow("coverage");
  expect(() => assertTrajectorySourceReview({ ...value, checkpointStateHash: "0".repeat(64) }, binding)).toThrow("snapshot");
  for (const verdict of ["fail", "unknown"]) expect(() => assertTrajectorySourceReview({ ...value, cases: [{ ...value.cases[0], verdict }] }, binding)).toThrow("source semantics");
  expect(() => assertTrajectorySourceReview({ ...value, cases: [{ ...value.cases[0], actionHash: "0".repeat(64) }] }, binding)).toThrow("action binding");
  expect(() => assertTrajectorySourceReview({ ...value, cases: [{ ...value.cases[0], evidencePaths: ["/checkpoint/made-up"] }] }, binding)).toThrow("evidence path");
});
