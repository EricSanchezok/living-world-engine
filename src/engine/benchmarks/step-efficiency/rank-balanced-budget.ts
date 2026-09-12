import { createCoverageAwareJointBudgetSelector } from "../../algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget";
import type { BatchCandidateSelector, BatchCandidateSelectorInput } from "../../algorithms/eager-reference/candidate-retrieval/runtime";

export type RankBalancedBudgetPolicy = "rank-depth" | "concave-rank";

/** Experimental allocation only; uses the existing selector's compact-domain seed. */
export function createRankBalancedBudgetSelector(policy: RankBalancedBudgetPolicy): BatchCandidateSelector {
  const baseline = createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: 0.15 });
  return (input: BatchCandidateSelectorInput): readonly string[] => {
    const lists = [...input.perSlot.values()].map(result => result.candidates);
    lists.sort((left, right) => {
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const order = left[i].candidateKey.localeCompare(right[i].candidateKey);
        if (order !== 0) return order;
      }
      return left.length - right.length;
    });
    const ranks = new Map<string, { best: number; weights: number[] }>();
    lists.forEach((list, slot) => list.forEach((candidate, rank) => {
      const entry = ranks.get(candidate.candidateKey) ?? { best: Infinity, weights: Array(lists.length).fill(0) as number[] };
      entry.best = Math.min(entry.best, rank);
      entry.weights[slot] = 1 / (rank + 1);
      ranks.set(candidate.candidateKey, entry);
    }));
    const kindCounts = new Map<string, number>();
    for (const candidate of input.candidates) if (ranks.has(candidate.candidateKey)) {
      kindCounts.set(candidate.kind, (kindCounts.get(candidate.kind) ?? 0) + 1);
    }
    const threshold = Math.max(1, Math.floor(input.budget * 0.15));
    const compact = new Set(input.candidates.filter(candidate =>
      ranks.has(candidate.candidateKey) && kindCounts.get(candidate.kind)! <= threshold).map(candidate => candidate.candidateKey));
    // Filtering the baseline preserves its exact compact overflow choices, too.
    const selected = new Set(baseline(input).filter(key => input.mandatoryKeys.has(key) || compact.has(key)));
    const compare = (left: string, right: string): number =>
      ranks.get(left)!.best - ranks.get(right)!.best || left.localeCompare(right);
    const available = [...ranks.keys()].filter(key => !selected.has(key)).sort(compare);
    if (policy === "rank-depth") return [...selected, ...available.slice(0, Math.max(0, input.budget - selected.size))].sort();

    const retained = Array(lists.length).fill(0) as number[];
    const addWeight = (key: string): void => {
      ranks.get(key)!.weights.forEach((weight, slot) => { retained[slot] += weight; });
    };
    [...selected].sort().forEach(addWeight);
    while (selected.size < input.budget && available.length > 0) {
      let bestIndex = 0, bestGain = -Infinity;
      for (let index = 0; index < available.length; index++) {
        const gain = ranks.get(available[index])!.weights.reduce((sum, weight, slot) =>
          sum + Math.log1p(weight / (1 + retained[slot])), 0);
        if (gain > bestGain) { bestGain = gain; bestIndex = index; }
      }
      const [key] = available.splice(bestIndex, 1);
      selected.add(key);
      addWeight(key);
    }
    return [...selected].sort();
  };
}
