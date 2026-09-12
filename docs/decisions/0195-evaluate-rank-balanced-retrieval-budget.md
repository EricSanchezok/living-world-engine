# Evaluate rank balanced retrieval allocation

## Status

Accepted
Class: architecture

## Context and Problem Statement

Occurrence coverage cannot distinguish shared candidates when the physical retriever ranks every visible candidate for every action. Comparing maximum raw scores across actions can favor one action's score scale. Relevant inventory and uncertainty evidence can disappear despite a useful rank within an individual action. Encoder consistency does not establish source-semantic quality.

## Decision Drivers

- Preserve the complete action cohort, shared budget and authored semantic possibilities.
- Separate allocation from ranking and representation changes.
- Avoid allocating by incomparable raw score scales or input order.
- Record new losses as well as recovered evidence.

## Considered Options

1. Compare the existing selector with minimum-rank and concave rank-utility selectors at an isolated benchmark boundary.
2. Assign disjoint equal quotas to actions by round robin.
3. Increase the shared budget or reduce batch size.
4. Promote an allocation rule after it restores selected historical references.

## Decision Outcome

Select the first option under [Spec 0143](../specs/0143-rank-balanced-retrieval-budget.md). Minimum rank exposes cross-action score-scale effects. Concave utility supplies diminishing returns for accumulated per-action rank weight while allowing evidence shared by multiple actions to help each one. Both remain experimental and use the existing compact-domain seed. Their objective values and mechanical invariants are separate from relevance and complete player acceptance.

## Pros and Cons of the Options

1. Provides two deterministic controls without extra model calls or a changed budget. Rank is only a relevance proxy; shared generic evidence can still dominate, and concavity supplies no hard fairness floor. The summarization literature supports the mathematical construction, not a game-performance claim.
2. Makes allocation visibly symmetric but handling duplicates and ties introduces additional policy; disjoint ownership ignores the value of evidence shared by actions.
3. Can recover recall but increases context cost or model call count before identifying the allocation failure. It is not the first optimization under the experiment's constraints.
4. Is cheap but overfits an incomplete set of outputs, which can themselves contain unnecessary or incorrect references. A recovered reference does not validate the rest of the new shortlist.

## Links

- [Lin and Bilmes, A Class of Submodular Functions for Document Summarization](https://aclanthology.org/P11-1052/): Sections 4.1–4.2 motivate diminishing-return coverage and concave aggregation. The approximation concerns the chosen objective, not semantic truth.
- [Complete-text representation experiment](0194-encode-complete-text-in-stable-width-windows.md).
- [Current joint allocation](../../src/engine/algorithms/eager-reference/candidate-retrieval/coverage-aware-joint-budget.ts).
