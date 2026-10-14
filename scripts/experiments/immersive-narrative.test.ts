import { describe, expect, it } from "vitest";
import { canContinueAfterLocalTaskFailure, plannedContinuityRounds, selectContinuityFlows } from "./immersive-narrative";

describe("frozen live conversation runner", () => {
  it("continues subsequent frozen inputs only after a local failure has readable feedback and a real input window", () => {
    const recovered = { status: "failed", stopReason: "local-model-task-failed", servicePaused: false, feedbackReady: true, canAct: true };
    expect(canContinueAfterLocalTaskFailure(recovered)).toBe(true);
    for (const changed of [{ servicePaused: true }, { feedbackReady: false }, { canAct: false }, { status: "running" }, { stopReason: "model-service-paused" }]) {
      expect(canContinueAfterLocalTaskFailure({ ...recovered, ...changed })).toBe(false);
    }
    // The earlier failed row is still recorded; neither input order nor denominator changes.
    expect(plannedContinuityRounds(selectContinuityFlows("confirmation"), new Set(["C05-1", "C05-2"]))).toHaveLength(72);
  });
  it("allows development probes while requiring complete confirmation and continuous cohorts", () => {
    expect(selectContinuityFlows("development", "D01,D08").map(flow => flow.id)).toEqual(["D01", "D08"]);
    expect(selectContinuityFlows("confirmation")).toHaveLength(12);
    expect(selectContinuityFlows("continuous")).toHaveLength(2);
    expect(selectContinuityFlows("development", "")).toHaveLength(8);
    expect(selectContinuityFlows("confirmation", "")).toHaveLength(12);
    expect(() => selectContinuityFlows("confirmation", "C01")).toThrow("entire frozen cohort");
    expect(() => selectContinuityFlows("continuous", "L02")).toThrow("entire frozen cohort");
    expect(() => selectContinuityFlows("development", "D01,C01")).toThrow("Unknown");
  });
  it("retains a planned row for every skipped round and every never-started flow", () => {
    const planned = plannedContinuityRounds(selectContinuityFlows("confirmation"), new Set(["C01-1", "C01-2"]));
    expect(planned).toHaveLength(72);
    expect(planned.filter(row => row.status === "recorded")).toHaveLength(2);
    expect(planned.filter(row => row.status === "not-run")).toHaveLength(70);
    expect(planned.at(-1)).toMatchObject({ flowId: "C12", turn: 6, evidenceFile: "C12-6.json", status: "not-run" });
  });
});
