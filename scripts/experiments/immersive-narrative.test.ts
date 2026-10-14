import { describe, expect, it } from "vitest";
import { plannedContinuityRounds, selectContinuityFlows } from "./immersive-narrative";

describe("frozen live conversation runner", () => {
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
