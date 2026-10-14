import { describe, expect, it } from "vitest";
import { CONTINUITY_AXES, CONTINUITY_CASES } from "../cases";
import { CONTINUITY_GATES, qualifyContinuity, type ContinuityReview } from "../qualification";

const gates = CONTINUITY_GATES.map(id => ({ id, passed: true, evidence: `${id}-entry-path-evidence.json` }));

function complete(): ContinuityReview[] {
  return CONTINUITY_CASES.filter(item => item.phase !== "development").flatMap(item => item.turns.map((_, index) => ({
    caseId: item.id, turn: index + 1, status: "complete" as const,
    axes: Object.fromEntries(CONTINUITY_AXES.map(axis => [axis, { passed: true, reason: "Specific evidence recorded for this axis" }])) as ContinuityReview["axes"],
    evidence: [`${item.id}-${index + 1}.json`], hardFailures: [],
  })));
}
describe("continuous qualification denominator and hard gates", () => {
  it("cannot pass with missing reviews or deleted difficult flows", () => {
    expect(qualifyContinuity([])).toMatchObject({ qualified: false, confirmation: { planned: 72, passed: 0 } });
    const partial = qualifyContinuity(complete().filter(row => row.caseId !== "C06"));
    expect(partial.confirmation.planned).toBe(72);
    expect(partial.qualified).toBe(false);
    expect(partial.rows.filter(row => row.status === "not-run")).toHaveLength(6);
  });
  it("requires 90% in each world and continuous session, not just a pooled score", () => {
    const reviews = complete();
    expect(qualifyContinuity(reviews, gates).qualified).toBe(true);
    reviews.slice(0, 4).forEach(row => { row.axes.response.passed = false; });
    const result = qualifyContinuity(reviews, gates);
    expect(result.confirmation.rate).toBeGreaterThan(0.9);
    expect(result.worlds.blackmarsh.rate).toBeLessThan(0.9);
    expect(result.qualified).toBe(false);
    const continuous = complete();
    continuous.filter(row => row.caseId === "L01").slice(0, 2).forEach(row => { row.axes.reference.passed = false; });
    expect(qualifyContinuity(continuous, gates).qualified).toBe(false);
  });
  it("cannot certify untested recovery or state invariants using prose scores alone", () => {
    const result = qualifyContinuity(complete());
    expect(result.confirmation.rate).toBe(1);
    expect(result.qualified).toBe(false);
    expect(result.unverifiedGates).toHaveLength(CONTINUITY_GATES.length);
    expect(qualifyContinuity(complete(), gates.map(gate => ({ ...gate, passed: gate.id !== "idle-window" }))).qualified).toBe(false);
  });
  it("includes failures and censored rounds and rejects hard violations despite polished prose", () => {
    const reviews = complete();
    reviews[0]!.status = "failed"; reviews[1]!.status = "censored";
    expect(qualifyContinuity(reviews).confirmation).toMatchObject({ planned: 72, passed: 70 });
    reviews[2]!.hardFailures.push("duplicate resource transfer after replay");
    expect(qualifyContinuity(reviews).qualified).toBe(false);
  });
  it("rejects duplicate, out-of-corpus and unsupported judgments", () => {
    const reviews = complete();
    expect(() => qualifyContinuity([...reviews, reviews[0]!])).toThrow("duplicate");
    expect(() => qualifyContinuity([{ ...reviews[0]!, caseId: "D01" }])).toThrow("Unexpected");
    reviews[0]!.evidence = [];
    expect(() => qualifyContinuity(reviews)).toThrow("Incomplete");
  });
});
