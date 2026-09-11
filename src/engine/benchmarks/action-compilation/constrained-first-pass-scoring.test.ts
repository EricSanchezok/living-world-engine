import { describe, expect, it } from "vitest";
import { constrainedFirstPassSchedule } from "./constrained-first-pass-protocol";
import { exactOneSidedMcNemar, selectConstrainedWinner, validateConstrainedScores, type ConstrainedTrialScore } from "./constrained-first-pass-scoring";

function scores() {
  return constrainedFirstPassSchedule("discovery").map((trial) => ({ trial, slots: 12,
    compilerAccepted: true, firstFormal: trial.arm !== "B" || trial.repetition < 3,
    tokens: trial.arm === "B" ? 1000 : 800, http: 1, wallMs: 100,
    firstFormalSlots: 12, finalFormalSlots: 12, firstSemanticSlots: 0, finalSemanticSlots: 0,
    input: 700, output: 100, cacheHit: 0, cacheMiss: 700, reasoning: null, cacheWrite: null, repairTokens: 0,
  } as ConstrainedTrialScore));
}
describe("AC-FP2 precommitted engineering gates", () => {
  it("refuses missing or duplicate trials", () => {
    const rows = scores();
    expect(() => validateConstrainedScores(rows.slice(1), "discovery")).toThrow("incomplete");
    expect(() => validateConstrainedScores([rows[0]!, ...rows.slice(0, -1)], "discovery")).toThrow("duplicate");
  });
  it("excludes the bridge and uses the fixed simplicity tie-break", () => {
    expect(selectConstrainedWinner(scores()).winner).toBe("S");
    const rows = scores();
    rows.filter((row) => row.trial.arm !== "B" && row.trial.arm !== "R").forEach((row) => { row.tokens = 1001; });
    expect(selectConstrainedWinner(rows).winner).toBeNull();
  });
  it("uses the exact directed paired binomial probability", () => {
    expect(exactOneSidedMcNemar(0, 0)).toBe(1);
    expect(exactOneSidedMcNemar(5, 0)).toBe(1 / 32);
    expect(exactOneSidedMcNemar(0, 5)).toBe(1);
    expect(exactOneSidedMcNemar(1, 1)).toBe(.75);
  });
});
