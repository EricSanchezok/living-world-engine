import { expect, it } from "vitest";
import { assertCompletedPlanReview } from "./step-dependent-resolution-playtest";

it("requires unchanged complete semantic review evidence before a fresh trajectory", () => {
  const manifest = { sourceHash: "source", initialPhysicalRequestHash: "request", slots: 12, actions: 43 };
  const report = { ...manifest, status: "completed", verdict: "accept",
    rows: Array.from({ length: 12 }, (_, slot) => ({ slot, verdict: "accept", plans: Array(slot === 0 ? 32 : 1).fill({}) })) };
  expect(() => assertCompletedPlanReview(report, manifest)).not.toThrow();
  for (const change of [{ sourceHash: "changed" }, { initialPhysicalRequestHash: "changed" }, { status: "stopped" },
    { verdict: "unknown" }, { rows: report.rows.slice(1) },
    { rows: report.rows.map(row => row.slot === 0 ? { ...row, verdict: "reject" } : row) },
    { rows: report.rows.map(row => row.slot === 0 ? { ...row, plans: [] } : row) }]) {
    expect(() => assertCompletedPlanReview({ ...report, ...change }, manifest)).toThrow("review has not passed");
  }
});
