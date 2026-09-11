import { describe, expect, it } from "vitest";
import type { BatchCandidateSelectorInput } from "../../../algorithms/eager-reference/candidate-retrieval/runtime";
import { createR5CoverageAwareBatchSelector } from "./r5-batch";

describe("R5 coverage-aware batch selector", () => {
  it("preserves compact candidate kinds before filling by global rank", () => {
    const candidates = [
      ...Array.from({ length: 2 }, (_, index) => ({
        candidateKey: `candidate_${(index + 1).toString(16).padStart(12, "0")}`,
        kind: "compact",
        allowedUses: ["target"],
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        candidateKey: `candidate_${(index + 3).toString(16).padStart(12, "0")}`,
        kind: "large",
        allowedUses: ["target"],
      })),
    ];
    const ranked = [...candidates].reverse().map((candidate, index) => ({
      candidateKey: candidate.candidateKey,
      score: 100 - index,
    }));
    const input: BatchCandidateSelectorInput = {
      candidates,
      perSlot: new Map([[0, { candidates: ranked }]]),
      mandatoryKeys: new Set(["candidate_000000000003"]),
      budget: 10,
    };

    const selected = createR5CoverageAwareBatchSelector({ compactKindBudgetRatio: 0.2 })(input);

    expect(selected).toHaveLength(10);
    expect(selected).toEqual(expect.arrayContaining([
      "candidate_000000000001",
      "candidate_000000000002",
      "candidate_000000000003",
    ]));
  });
});
