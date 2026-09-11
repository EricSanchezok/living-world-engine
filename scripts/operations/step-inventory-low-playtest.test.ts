import { expect, it } from "vitest";
import { assertInventoryLowAdmission } from "./step-inventory-low-playtest";

function fixture() {
  const sources = Array.from({ length: 6 }, (_, index) => ({ id: `source-${index}` }));
  const order = sources.flatMap(source => [0, 1].flatMap(repeat => ["B", "L"].map(arm => ({ source: source.id, repeat, arm }))));
  const design = { trialId: "probes-e1-inventory-low-01", toolHash: "8444a76266c485ce005714b834ebf064c1b36f3cfbd24b6f049ad12c1d3f60d3", sources, order };
  const report = { ...design, status: "completed", rows: order.map(row => ({ ...row,
    usage: { input: 100, output: 10, cacheHit: 90 }, rawJson: true,
    formatCoverageAndBoundary: row.arm === "L", inferenceValid: true })) };
  return { report, design };
}

it("admits only a complete paired improvement meeting every prespecified gate", () => {
  const { report, design } = fixture();
  expect(assertInventoryLowAdmission(report, design)).toEqual({ baselinePass: 0, candidatePass: 12, baselineTokens: 1320, candidateTokens: 1320 });
  report.rows.filter(row => row.arm === "L").slice(0, 4).forEach(row => { row.formatCoverageAndBoundary = false; });
  expect(() => assertInventoryLowAdmission(report, design)).toThrow("admission gate");
});

it("rejects incomplete, reordered, unverified, tied, costly and missing-stratum evidence", () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>["report"]) => { r.status = "running"; },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.reverse(); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows[1]!.inferenceValid = false; },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.forEach(row => { row.formatCoverageAndBoundary = true; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.filter(row => row.arm === "L").forEach(row => { row.usage.output = 100; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.filter(row => row.arm === "L" && row.source === "source-0").forEach(row => { row.formatCoverageAndBoundary = false; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows[1]!.rawJson = false; },
  ]) {
    const { report, design } = fixture();
    mutate(report);
    expect(() => assertInventoryLowAdmission(report, design)).toThrow();
  }
});
