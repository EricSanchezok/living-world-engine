import type {
  BatchCandidateSelector,
  BatchCandidateSelectorInput,
  SlotRetrievalResult,
} from "./runtime";

export interface CoverageAwareJointBudgetOptions {
  /** A kind at or below this fraction of the physical budget is cheap enough
   * to preserve losslessly before the remaining candidates compete by rank. */
  compactKindBudgetRatio?: number;
}

interface Aggregate {
  coverage: number;
  score: number;
  bestRank: number;
}

function aggregates(perSlot: ReadonlyMap<number, SlotRetrievalResult>): Map<string, Aggregate> {
  const output = new Map<string, Aggregate>();
  for (const result of perSlot.values()) result.candidates.forEach((candidate, rank) => {
    const value = output.get(candidate.candidateKey) ?? {
      coverage: 0,
      score: Number.NEGATIVE_INFINITY,
      bestRank: Number.MAX_SAFE_INTEGER,
    };
    value.coverage += 1;
    value.score = Math.max(value.score, candidate.score);
    value.bestRank = Math.min(value.bestRank, rank);
    output.set(candidate.candidateKey, value);
  });
  return output;
}

function compareAggregate(
  leftKey: string,
  rightKey: string,
  values: ReadonlyMap<string, Aggregate>,
): number {
  const left = values.get(leftKey) ?? { coverage: 0, score: Number.NEGATIVE_INFINITY, bestRank: Number.MAX_SAFE_INTEGER };
  const right = values.get(rightKey) ?? { coverage: 0, score: Number.NEGATIVE_INFINITY, bestRank: Number.MAX_SAFE_INTEGER };
  return right.coverage - left.coverage || right.score - left.score ||
    left.bestRank - right.bestRank || leftKey.localeCompare(rightKey);
}

/**
 * Coverage-aware physical-batch allocation used by relational RRF v1.
 *
 * Small typed domains are retained losslessly because one omitted member can
 * erase an entire semantic role while costing little compared with the 20%
 * batch budget. The remaining candidates keep the runtime's established
 * coverage/score/rank ordering, so this policy changes allocation rather than
 * inventing a second retrieval score.
 */
export function createCoverageAwareJointBudgetSelector(
  options: CoverageAwareJointBudgetOptions = {},
): BatchCandidateSelector {
  const compactKindBudgetRatio = options.compactKindBudgetRatio ?? 0.15;
  if (!Number.isFinite(compactKindBudgetRatio) || compactKindBudgetRatio <= 0 || compactKindBudgetRatio > 0.25) {
    throw new Error("compactKindBudgetRatio must be in (0, 0.25]");
  }
  return (input: BatchCandidateSelectorInput): readonly string[] => {
    const values = aggregates(input.perSlot);
    const scored = new Set(values.keys());
    const byKind = new Map<string, string[]>();
    for (const candidate of input.candidates) {
      if (!scored.has(candidate.candidateKey)) continue;
      const keys = byKind.get(candidate.kind) ?? [];
      keys.push(candidate.candidateKey);
      byKind.set(candidate.kind, keys);
    }
    const compactThreshold = Math.max(1, Math.floor(input.budget * compactKindBudgetRatio));
    const compactKinds = [...byKind]
      .filter(([, keys]) => keys.length <= compactThreshold)
      .sort(([leftKind, left], [rightKind, right]) =>
        left.length - right.length || leftKind.localeCompare(rightKind));
    const selected = new Set(input.mandatoryKeys);
    for (const [, keys] of compactKinds) {
      for (const key of [...keys].sort((left, right) => compareAggregate(left, right, values))) {
        if (selected.size >= input.budget) return [...selected];
        selected.add(key);
      }
    }
    const ranked = [...values.keys()].sort((left, right) => compareAggregate(left, right, values));
    for (const key of ranked) {
      if (selected.size >= input.budget) break;
      selected.add(key);
    }
    return [...selected];
  };
}

/** Historical benchmark aliases; both names resolve to this implementation. */
export type R5CoverageAwareBatchSelectorOptions = CoverageAwareJointBudgetOptions;
export const createR5CoverageAwareBatchSelector = createCoverageAwareJointBudgetSelector;
