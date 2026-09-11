# Supply Activity Execution Evidence

## Status

Accepted
Class: architecture

## Context and Problem Statement

An action can include preparations, waiting and later objectives. Description and nullable completion time cannot distinguish its temporal profile, current progress or next checkpoint. A semantic reviewer without the interval shares that ambiguity. Canonical execution state already contains those facts.

## Decision Drivers

- Adjudicate the current interval while preserving the complete action.
- Share factual execution evidence with generation and review.
- Preserve partial progress and continuous effects.
- Avoid hidden changes to cached context or runtime defaults.

## Considered Options

1. Supply a bound typed projection of existing execution state through an opt-in context field.
2. Ask the model to infer execution timing from action prose and description.
3. Suppress all effects until an activity checkpoint or completion.

## Decision Outcome

The experimental Truth setting projects factual temporal state without deciding outcomes. It preserves the original context and adds joinable handle references. Planning and review consume the same source interval. [Spec 0038](../specs/0038-activity-temporal-evidence.md) defines the contract and promotion requirements.

## Pros and Cons of the Options

1. The projection makes timing and progress inspectable and testable. It increases input size and cannot by itself prove faithful open semantics.
2. Prose remains necessary for intent but cannot reconstruct missing engine progress or distinguish an unscheduled activity from one with an open-ended goal.
3. Universal suppression avoids some premature outcomes but breaks ongoing consumption, partial movement, interruptions and other effects that can occur before a checkpoint.

## Links

- [Temporal runtime](../../src/engine/mechanics/temporal.ts).
- [Truth context builder](../../src/engine/contracts/prompts.ts).
- [Game first principles](0004-game-first-principles.md).
