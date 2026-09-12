# Rank balanced retrieval budget experiment

Artifact-Version: 1
Status: Approved

## Intent

Evaluate allocation of the existing shared candidate budget under the authorized [player action efficiency experiment](0122-player-action-efficiency.md). Complete per-slot ranking lists give nearly every shared candidate identical occurrence coverage. Allocation quality needs a separate comparison from encoder consistency. Production defaults remain unchanged.

## Contract

Freeze three arms before measuring the original five batches and 49 actions: the existing coverage/maximum-score selector, minimum per-action rank, and greedy concave rank utility. Keep source actions, rankings, scopes, strict 20% budget, mandatory anchors and compact-kind allocation unchanged. The experimental selectors accept the existing runtime input and never inspect historical model outputs or candidate meanings. Use the baseline's actual retained compact candidates as a common seed, including its overflow behavior.

Rank-depth selection orders by minimum zero-based per-slot rank and then candidate key. Concave selection assigns weight 1/(rank+1) within each action and maximizes the sum over actions of log(1+retained weight), greedily selecting the largest marginal gain after the common seed. Tie-break by minimum rank and candidate key. Canonically order ranking lists before summing so slot numbering, map order and catalog order cannot alter floating-point accumulation or output membership. Neither policy guarantees a minimum quota or semantic relevance.

Run all arms through the real retrieval runtime, preserving its validation, slot visibility and context projection. Bind the complete frozen ranking artifacts and input identities; confirm their baseline reproduces the recorded full context and shortlisted keys. Record every arm's full selection, budget, per-action rank coverage, historical-reference omissions, changed candidate source records and selector time. Historical references are warning evidence, not a gold label or a scoring target. Review new omissions against original action intent. Do not tune on restored reference counts or call a narrower set of omissions a semantic qualification.

This comparison uses the complete-text encoder candidate's recorded rankings and therefore cannot qualify that representation or isolate an effect under the production encoder. No provider HTTP, model output rewriting, world mutation, default promotion or player latency claim belongs to this offline experiment.

## Plan

1. Implement isolated benchmark selectors and deterministic counterexample tests.
2. Freeze implementation and source hashes, then compare all three arms on all 49 original actions.
3. Review candidate losses and retain negative results before selecting any prospective follow-up.

## Verification

Test a high-score action starving a lower-score action, permutation invariance, compact-domain preservation and mandatory budget saturation. Run the unchanged runtime against the complete frozen source cohort. Run focused tests and `npm run check:fast` before committing.

## Evidence

The [benchmark selectors](../../src/engine/benchmarks/step-efficiency/rank-balanced-budget.ts) and their [counterexample tests](../../src/engine/benchmarks/step-efficiency/rank-balanced-budget.test.ts) own this experiment. [The decision](../decisions/0195-evaluate-rank-balanced-retrieval-budget.md) records the alternatives and transfer limits.
