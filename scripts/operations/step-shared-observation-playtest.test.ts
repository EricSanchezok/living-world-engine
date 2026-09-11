import { expect, it } from "vitest";
import { assertSharedInventoryAdmission, assertPerspectiveObservationAdmission } from "./step-shared-observation-playtest";

function fixture(kind: "observation" | "inventory" = "observation") {
  const sources = Array.from({ length: 6 }, (_, i) => `source-${i}`);
  const order = [0, 1].flatMap(repeat => ["B", kind === "observation" ? "L" : "S"].flatMap(arm =>
    kind === "inventory" && arm === "B" ? sources.map(source => ({ repeat, arm, sources: [source] })) : [{ repeat, arm, sources }]));
  const design = { trialId: kind, toolHash: "tool", treatmentHash: "body", preparationHash: "preparation",
    sourceHashes: sources.map(id => ({ id })), order };
  const report = { ...design, status: "completed", rows: order.map(row => ({ ...row, rawJson: true, envelopeValid: true,
    inferenceValid: true, elapsedMs: 100, logical: row.sources.map(source => ({ source, formatCoverageAndBoundary: true })),
    usage: { input: 1000, output: row.arm === "L" ? 100 : 10, cacheHit: 900 } })) };
  return { design, report };
}

function reviewFor(report: ReturnType<typeof fixture>["report"]) {
  const expected = { trialId: report.trialId, reportHash: "report", preflightHash: "preflight",
    cases: report.rows.filter(row => row.arm === "L").flatMap(row => row.sources.map(source => ({ source, repeat: row.repeat,
      sourceContextHash: `context-${source}`, outputHash: `output-${source}-${row.repeat}` }))) };
  return { expected, review: { ...expected, method: "source-bound-assistant-review", cases: expected.cases.map(entry => ({ ...entry,
    verdict: "pass", reason: "Attribution and access checked against the exact source." })) } };
}

it("requires source-bound semantic inspection even when all twelve slots mechanically pass", () => {
  const { report, design } = fixture(), { review, expected } = reviewFor(report);
  expect(assertPerspectiveObservationAdmission(report, design, review, expected).arm).toBe("L");
  review.cases[5]!.verdict = "fail";
  expect(() => assertPerspectiveObservationAdmission(report, design, review, expected)).toThrow("semantic review");
  review.cases[5]!.verdict = "unknown";
  expect(() => assertPerspectiveObservationAdmission(report, design, review, expected)).toThrow("semantic review");
  review.cases[5]!.verdict = "pass";
  review.cases[5]!.outputHash = "another-output";
  expect(() => assertPerspectiveObservationAdmission(report, design, review, expected)).toThrow("semantic review");
});

it("rejects incomplete, reordered, wrong-mode, unbound, costly and misassigned observations", () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>["report"]) => { r.status = "running"; },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.reverse(); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows[0]!.inferenceValid = false; },
    (r: ReturnType<typeof fixture>["report"]) => { r.toolHash = "changed"; },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.filter(row => row.arm === "L").forEach(row => { row.usage.input = 739161; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.forEach(row => { row.envelopeValid = false; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.forEach(row => { row.rawJson = false; }); },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows[0]!.logical[0]!.source = "other-observer"; },
    (r: ReturnType<typeof fixture>["report"]) => { r.rows.forEach(row => { row.logical[0]!.formatCoverageAndBoundary = false; }); },
  ]) {
    const { report, design } = fixture(), { review, expected } = reviewFor(report); mutate(report);
    expect(() => assertPerspectiveObservationAdmission(report, design, review, expected)).toThrow();
  }
});

it("requires shared inventory to preserve paired coverage and halve total tokens", () => {
  const { report, design } = fixture("inventory");
  expect(assertSharedInventoryAdmission(report, design).candidate.passed).toBe(12);
  report.rows.filter(row => row.arm === "S").forEach(row => { row.usage.output = 10000; });
  expect(() => assertSharedInventoryAdmission(report, design)).toThrow("admission gate");
});
