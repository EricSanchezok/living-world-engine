import { describe, expect, it } from "vitest";
import { REVIEW_DIMENSIONS } from "./constrained-semantic-review";
import { assertCalibrationProofs, buildFp3Calibration, makeReviewEntry, scoreFp3Calibration,
  validateFp3Review, visibleReviewPacket, type SemanticReviewPacket } from "./semantic-first-pass-review";

function packet(): SemanticReviewPacket {
  const state = { revision: 0 }, rules = { meaning: "Preserve the requested actor." };
  return { state, rules, entries: [
    makeReviewEntry({ actor: "a" }, { actor: "a" }, state, rules),
    makeReviewEntry({ actor: "b" }, { actor: "b" }, state, rules),
  ] };
}
function response(input: SemanticReviewPacket) {
  return { results: visibleReviewPacket(input).entries.map((entry) => ({ id: entry.id,
    checks: REVIEW_DIMENSIONS.map((dimension) => ({ dimension, verdict: "pass" as const,
      reason: "The source and output identify the same actor.", evidenceIds: entry.evidence.map((atom) => atom.id) })) })) };
}

describe("AC-FP3 evidence-bound calibration gate", () => {
  it("rejects changed state/rule versions before any reviewer request", () => {
    const input = packet();
    input.state = { revision: 1 };
    expect(() => visibleReviewPacket(input)).toThrow("identity drift");
    const other = packet();
    other.rules = { meaning: "Changed" };
    expect(() => visibleReviewPacket(other)).toThrow("identity drift");
  });
  it("keeps exact evidence references scoped to their own action", () => {
    const input = packet(), output = response(input);
    expect(validateFp3Review(output, input).every((row) => row.usable)).toBe(true);
    output.results[0]!.checks[0]!.evidenceIds = output.results[1]!.checks[0]!.evidenceIds;
    const reviewed = validateFp3Review(output, input);
    expect(reviewed[0]!.usable).toBe(false);
    expect(reviewed[0]!.checks[0]!.verdict).toBe("unresolved");
    expect(reviewed[1]!.usable).toBe(true);
    output.results[1]!.id = "not-a-requested-action";
    expect(validateFp3Review(output, input).every((row) => !row.usable)).toBe(true);
  });
  it("rejects duplicate dimensions, missing IDs and invented citations without turning them into semantic failures", () => {
    const input = packet(), output = response(input);
    output.results[0]!.checks[1]!.dimension = output.results[0]!.checks[0]!.dimension;
    output.results[1]!.checks[0]!.evidenceIds = ["invented-evidence"];
    expect(validateFp3Review(output, input).every((row) => !row.usable)).toBe(true);
    expect(validateFp3Review({ results: [] }, input).every((row) => !row.usable)).toBe(true);
  });
  it("binds controlled labels to actual source/output values and withholds labels from reviewers", () => {
    const calibration = buildFp3Calibration();
    assertCalibrationProofs(calibration);
    for (const dimension of REVIEW_DIMENSIONS) for (const polarity of ["pass", "fail", "unresolved"]) {
      expect(calibration.cases.filter((item) => item.dimension === dimension && item.expected === polarity)).toHaveLength(polarity === "unresolved" ? 4 : 16);
    }
    const visible = visibleReviewPacket({ ...calibration, entries: calibration.cases.slice(0, 12).map((item) => item.entry) });
    expect(visible).not.toHaveProperty("cases");
    expect(visible.entries[0]).not.toHaveProperty("expected");
    calibration.cases[0]!.expected = "fail";
    expect(() => assertCalibrationProofs(calibration)).toThrow(/drift|contradiction/);
  });
  it("does not certify an agree-with-everything evaluator or missing review output", () => {
    const calibration = buildFp3Calibration();
    const reviews = calibration.cases.flatMap(({ entry }) => {
      const input = { ...calibration, entries: [entry] };
      return validateFp3Review(response(input), input);
    });
    const score = scoreFp3Calibration(calibration, reviews);
    expect(score.positive.correct).toBe(112);
    expect(score.negative.correct).toBe(0);
    expect(score.unresolved.correct).toBe(0);
    expect(score.calibrated).toBe(false);
    const missing = scoreFp3Calibration(calibration, []);
    expect(missing.usable).toBe(0);
    expect(missing.unresolved.correct).toBe(0);
  });
});
