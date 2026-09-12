# Adjudicate Wait and Travel Objectives

Artifact-Version: 1
Status: Approved

## Intent

Represent a finite wait or unknown-distance journey without requiring an invented onset invariant. The complete-player objective remains in [Spec 0122](0122-player-action-efficiency.md).

## Contract

An isolated world changes only the kind of the two explicitly selected profiles, `wait-until` and `travel-until-arrival`, from conditional to goal. Profile IDs, names, selection rules, 300/600-second check intervals, calibrations, resource claims and interruption settings retain their exact values. All other world fields remain unchanged. The complete finite-work and short-checkpoint source world is required.

The existing goal contract permits every former nonempty continuation assertion list and additionally permits no extra invariant. This is an authored world-contract expansion, not equivalent validation or a reinterpretation of recorded output. It neither removes a source condition nor substitutes a true condition for an invalid one. Conditions remain checked by the original onset and continuation validators. Actual supported outcomes still own completion; waiting for a future condition does not assert it already holds. Fixed, rate, staged and indefinite work retain their existing contracts. The engine does not classify action text or convert saved Activities.

## Plan

Use the preceding complete finite-work world and local reference-use comparison as an explicitly sealed counterfactual baseline. First validate the changed world contract and its runtime behavior, then run one full-source paired compiler screen. Default worlds and existing instances do not select the candidate.

## Verification

Verify exact reversal of only the two profile kinds at both template and first-action state boundaries, including history base and all bootstrap cognition. Through the actual temporal materializer, boundary selection, advance, outcome reconciliation and continuation settlement, compare conditional and goal plans with the same nonempty assertions. Preserve timing, resource ownership, continuing/succeeded/failed/blocked outcomes, and blocking after a prerequisite fails. Separately show the intentional admission difference for an empty list. These are runtime contract checks, not natural-language acceptance.

Freeze the complete original 49-action cohort and original 12/12/12/5/8 physical batches. Both model arms retain the local reference-use view from [Spec 0139](0139-materialize-action-local-reference-uses.md); its closed result is a comparison baseline, not a promoted component. B must exactly reconstruct the sealed preceding C requests. C changes only the two world profile kinds and the resulting original retrieval/schema projections. Offline B replays every prior response and preserves normalization and rejection. C captures complete requests without reusing aliases from a different context.

One prospective cohort permits at most ten primary HTTP calls with disabled-thinking DeepSeek Flash, alternating arm order, independent cold query caches per physical batch, warm passage caches, and no repair/retry/redraw. Require a clean committed producer, complete usage and physical audits; a missing response or audit stops later dispatch. Retain all errors, changed shortlists, full source actions and semantic counterexamples. Report input/output/cache usage, compiler and transport timing separately from player latency. Source review must distinguish invariant relevance, condition satisfaction, objective completion and indefinite work. No formal pass count alone permits promotion. A fresh full player trajectory remains necessary.

## Evidence

The runtime already shares scheduling and outcome reconciliation for conditional and goal profiles. Conditional alone requires a nonempty assertion list. A false continuation assertion blocks an active Activity rather than completing its objective. The preceding source-bound comparison retained an accepted wait based on commander identity and rejected an absence assertion about a present fact describing a missing army. [Decision 0192](../decisions/0192-adjudicate-authored-wait-and-travel-goals.md) records why a world-contract adjustment is distinct from the closed onset-schema specialization.
