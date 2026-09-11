import { expect, it } from "vitest";
import { scoreOwnershipReview } from "./step-plan-review-ownership-probe";

it("requires both labels in a single complete first response and preserves unknowns", () => {
  const labels = Array.from({ length: 12 }, (_, index) => ({ expected: index % 2 ? "accept" as const : "reject" as const }));
  const report = { status: "completed", dispatches: 1, rows: labels.map((label, slot) => ({ slot, verdict: label.expected, error: null })) };
  expect(scoreOwnershipReview(labels, report)).toMatchObject({ eligible: true, positiveCorrect: 6, negativeCorrect: 6 });
  expect(scoreOwnershipReview(labels, { ...report, dispatches: 2 }).eligible).toBe(false);
  expect(scoreOwnershipReview(labels, { ...report, rows: report.rows.map(row => ({ ...row, verdict: "accept" })) }).eligible).toBe(false);
  expect(scoreOwnershipReview(labels, { ...report, rows: report.rows.map(row => row.slot === 0 ? { ...row, verdict: "unknown" } : row) }).eligible).toBe(false);
  expect(scoreOwnershipReview(labels, { ...report, rows: [...report.rows.slice(1), report.rows[1]!] }).intact).toBe(false);
});
