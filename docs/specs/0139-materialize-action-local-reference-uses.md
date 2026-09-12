# Materialize Action-Local Reference Uses

Artifact-Version: 1
Status: Approved

## Intent

Reduce Action Compilation's observed Entity/Agent field confusion and cross-action identity selection by placing exact existing reference relationships beside each actor and target. The complete-player objective remains owned by [the player efficiency spec](0122-player-action-efficiency.md).

## Contract

The experimental input adapter adds a field-use view to each complete source slot after retrieval and alias encoding. The view pairs each selectable target Entity with every selectable Agent whose existing catalog details explicitly bind that Entity. Actor references use their already declared actor-to-Entity pair. Scope, kind and allowed-use predicates are checked against the original compiler contracts. Labels and textual similarity never establish a binding. Ambiguous targets retain every visible alternative; missing details, stale bindings and unresolved targets remain explicit, without guessed identities or new catalog entries.

The added view is an aid to selecting existing records, not a required dependency or audience set. Every original slot, action string, target status, context field, catalog candidate and output choice remains intact and ordered. Removing the added slot field reconstructs the original ordered context exactly. The original schema, alias dictionary, parser, output preprocessing, per-slot validation and materializer retain authority. No wrong output is repaired by substituting a linked record. AgentMind and ordinary client projections are unchanged.

## Plan

Use the exact finite-work counterfactual world and complete 49-action cohort from [the finite-work comparison](0138-preserve-finite-work-experiment-world.md). Both arms share that world, source cognition, original five batches, retrieval settings and alias representation. The baseline is the sealed C arm of that comparison, explicitly identified as prior counterfactual compilation evidence rather than a gameplay or Ledger source. The treatment adds only the local field-use view and its instructions. [Decision 0191](../decisions/0191-materialize-action-local-reference-uses.md) records the alternatives.

## Verification

Test label-collision worlds with swapped authoritative bindings, multiple Agents bound to one Entity, scoped candidates, missing details, unresolved and stale references, and exact context reversal. Compare original and adapted requests through the real represented compiler with recorded external responses, retaining both accepted and rejected materializations.

Freeze all ten ordered requests on a clean committed producer. Baseline requests must exactly match the preceding finite-work C requests. Both offline arms replay the same original complete response through an unchanged output dictionary and must preserve normalization and slot rejection, including failures. A single new prospective cohort permits at most ten primary HTTP calls, one per original batch and arm, with DeepSeek Flash and thinking disabled. Alternate arm order, use independent cold query caches per physical batch and warm passage caches, and block repairs and retries before network access. Missing response usage or transport failure stops subsequent dispatch; preserve every response and audit.

Report complete input/output/cache usage, time, formal errors and source-semantic counterexamples separately. Include the observed wrong-father audience, unrelated continuation fact and finite/ongoing selection errors in source review. The view supplies no proof that a target belongs in the audience or that a condition expresses the action. No single cohort estimates stable reliability or establishes player acceleration. A failed candidate is not redrawn or promoted; fresh complete-player validation remains required.

## Evidence

The finite-work comparison exposed both invalid field uses and a wrong Agent selection despite an already visible correct target Entity, kinship fact and Agent-to-Entity link. This contract concerns the placement of those existing relationships, not recovery of missing knowledge. [RAT-SQL](https://aclanthology.org/2020.acl-main.677/) motivates representing known relations alongside the current query; its trained relation-aware attention architecture and reported accuracy do not establish an effect for this prompt-only experiment.
