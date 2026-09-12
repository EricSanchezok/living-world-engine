# Separate interval receipts from task status

## Status
Accepted
Class: bug-fix

## Context and Problem Statement

A ResolutionPlan describes conditional stakes in the current interval, while an Activity describes the entire source task. Coupling receipt consumption to task completion loses legitimate intermediate effects and leaves committed interval checks without their derived consequences. An old receipt is historical evidence, not a pending operation automatically consumed at a later boundary.

## Decision Drivers

- Preserve ongoing consequences and complete source tasks.
- Keep deterministic check derivation, exact-once mechanics and atomic replay.
- Avoid an extra model call or an inferred effect-timing choice.
- Retain independent source-semantic and full-player qualification.

## Considered Options

1. Settle current-interval receipts independently of whole-task outcomes.
2. Preserve every old receipt and apply it on task completion.
3. Suppress checks or require separate transition mechanics while a task continues.

## Decision Outcome

The [interval settlement contract](../specs/0134-settle-interval-resolution-effects.md) makes receipts authoritative for the current interval and Activity state authoritative for whole-task progress. The engine consumes each accepted receipt exactly once. A continuing outcome may accompany a successful or failed interval check. Temporal and causal validation remain responsible for whether the task can continue or end. This supersedes the receipt-deferral portion of [0162](0162-separate-task-completion-from-interval-effects.md), retaining its support for partial operations and events.

PDDL2.1 distinguishes temporal conditions and effect points within durative actions. This motivates separating lifecycle from consequence timing; it does not supply an open-language semantic oracle, a check-reuse algorithm, or a latency claim. The implementation retains discrete engine-selected boundaries and does not introduce PDDL translation or continuous integration.

## Pros and Cons of the Options

1. Uses the existing interval-bound plan and check without increasing calls or generated fields. Correctness still depends on source-grounded plan and causal review; interval settlement must not be mistaken for task completion.
2. Delays consequences that should affect intervening actions and resources. It also accumulates plans made against distinct states and requires an unsupported rule for combining them.
3. Suppression removes legitimate uncertainty. Separate mechanics duplicate the already committed receipt decision and can omit or double-apply its consequence.

## Links

- [PDDL2.1, Fox and Long, section 5](https://doi.org/10.1613/jair.1129)
- [Activity evidence](0128-supply-activity-execution-evidence.md)
- [Lost interval effects](../postmortems/0131-continuing-actions-discarded-interval-receipts.md)
