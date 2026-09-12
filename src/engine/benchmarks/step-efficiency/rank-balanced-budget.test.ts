import { describe, expect, it } from "vitest";
import { createCoverageAwareJointBudgetSelector } from "../../algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import type { BatchCandidateSelectorInput } from "../../algorithms/eager-reference/candidate-retrieval/runtime";
import { createRankBalancedBudgetSelector } from "./rank-balanced-budget";

const key = (value: number): string => `candidate_${value.toString(16).padStart(12, "0")}`;
function fixture(): BatchCandidateSelectorInput {
  return {
    candidates: Array.from({ length: 8 }, (_, index) => ({ candidateKey: key(index), kind: "entity", allowedUses: ["subject"] })),
    mandatoryKeys: new Set(), budget: 2,
    perSlot: new Map([
      [0, { candidates: [0, 1, 2, 3, 4, 5, 6, 7].map((id, rank) => ({ candidateKey: key(id), score: 100 - rank })) }],
      [1, { candidates: [7, 6, 5, 4, 3, 2, 1, 0].map((id, rank) => ({ candidateKey: key(id), score: 1 - rank / 10 })) }],
    ]),
  };
}

describe.each(["rank-depth", "concave-rank"] as const)("%s budget experiment", policy => {
  const select = createRankBalancedBudgetSelector(policy);
  it("exposes a shared-list score-scale counterexample without enlarging the budget", () => {
    const input = fixture();
    expect(createCoverageAwareJointBudgetSelector()(input)).toEqual([key(0), key(1)]);
    expect(select(input)).toEqual([key(0), key(7)]);
  });
  it("preserves selection when catalog order, slot order, numbering and raw score scale change", () => {
    const input = fixture();
    const reversed = { ...input, candidates: [...input.candidates].reverse(),
      perSlot: new Map([...input.perSlot].reverse().map(([slot, value]) => [slot + 70, {
        candidates: value.candidates.map(candidate => ({ ...candidate, score: candidate.score * 1000 })),
      }])) };
    expect(select(reversed)).toEqual(select(input));
  });
  it("keeps a compact typed domain even when it ranks below ordinary entities", () => {
    const input = fixture();
    input.candidates = input.candidates.map((candidate, index) => ({ ...candidate, kind: index === 3 ? "quantity" : candidate.kind }));
    expect(select(input)).toContain(key(3));
    expect(select(input)).toHaveLength(2);
  });
  it("preserves a saturated mandatory floor", () => {
    const input = fixture();
    input.mandatoryKeys = new Set([key(4), key(5)]);
    expect(select(input)).toEqual([key(4), key(5)]);
  });
});
