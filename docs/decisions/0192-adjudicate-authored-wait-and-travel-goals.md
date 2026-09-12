# Adjudicate authored wait and travel goals

## Status

Accepted
Class: architecture

## Context and Problem Statement

The example world's conditional profiles recommend waiting until a condition or travelling an unknown distance. The runtime requires an already-true continuation assertion for conditional work, blocks an active Activity when such an assertion fails, and completes both conditional and goal work from a supported succeeded outcome. Requiring an extra invariant does not express the future objective. The observed compiler sometimes fills that obligation with an unrelated current fact. Goal profiles already support the same checks and outcomes without making an extra invariant mandatory.

## Decision Drivers

- Preserve complete objectives, optional genuine invariants and all authored timing.
- Reduce an unnecessary generation obligation without assigning completion to the clock.
- Keep natural-language classification outside the kernel.
- Separate a world-contract change from codec repair and default promotion.

## Considered Options

1. Change the two authored wait/travel profiles to goal in an isolated world.
2. Clarify their calibration prose while retaining the mandatory invariant.
3. Repeat onset-schema branch specialization or replace invalid conditions.
4. Remove conditional contracts from the engine globally.

## Decision Outcome

The experiment selects the first option. It changes only the two profile kind values and preserves every other world field. Existing nonempty condition lists retain their runtime behavior; empty lists become eligible under the existing goal contract. This deliberately expands the authored admission contract rather than claiming identical legal output. [Spec 0140](../specs/0140-adjudicate-wait-and-travel-objectives.md) owns the controlled comparison, source-semantic review and player admission. The runtime and default world retain their current behavior while the candidate is evaluated.

## Pros and Cons of the Options

1. Reuses the already shared scheduling and completion implementation and retains optional prerequisites. It does not prevent invented optional conditions, indefinite-profile mistakes or false semantic completion; direct model and player evidence is required.
2. Improves wording but still forces a condition when the source merely describes a future objective. The existing compiler prompt already distinguishes genuine prerequisites from unrelated facts.
3. [Onset specialization](0175-specialize-uninhabited-onset-branches.md) is a closed independent negative experiment. Replacing a predicate invents intent. Neither establishes that a source needs an invariant.
4. Removes an authored requirement that other worlds may intentionally impose. The current evidence concerns two example profiles and does not justify a global contract removal.

## Links

- [Goal-directed Activities](0116-goal-directed-temporal-activities.md).
- [Short-action progress checkpoints](0135-adjudicate-generic-short-action-completion.md).
- [Temporal runtime](../../src/engine/mechanics/temporal.ts).
- [PDDL2.1](https://arxiv.org/abs/1106.4561), Section 5.1, distinguishes start/end conditions from interval invariants. This supports keeping their responsibilities distinct; the experiment does not implement its planner, open-interval semantics or validation calculus.
