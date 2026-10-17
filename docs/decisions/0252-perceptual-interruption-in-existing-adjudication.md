# Perceptual interruption in existing adjudication

## Status
Accepted
Class: architecture

## Context and Problem Statement

A participant can request a long activity with a stopping condition, such as resting until directly called. The runtime retained the requested duration but had no executable representation of that condition. Ordinary observations woke the intent after its active work completed, so the character could hear a matching call and continue for the entire interval. Arbitrary language prevents a fixed event-name table from expressing all such conditions.

## Decision Drivers

- Preserve the participant's stated condition and exact requested duration.
- Stop only on an event actually delivered at its world-time boundary.
- Retain semantic freedom without adding a mandatory polling call.
- Cancel unperformed effects while preserving committed progress and replay.
- Keep local calendars and world content script-driven.

## Considered Options

- Match a fixed set of phrases and event categories in the kernel.
- Ask a separate semantic interruption question after each event or checkpoint.
- Include candidate stopping conditions in the existing world-adjudication batch, then enforce delivery and cancellation in the kernel.

## Decision Outcome

Use the existing action-reading batch to preserve an explicit stopping condition from the participant's request. The existing world batch judges whether an action's perceptible result would satisfy another active activity's condition. The kernel applies that match only when the event actually occurs and is delivered to the activity owner. It cancels the unperformed tail without granting a reply, expenditure or new action.

Prepared actions retain which active conditions were considered. A newly admitted eligible activity invalidates the retained matching context. Removing or completing an activity does not itself require another semantic decision: the kernel ignores candidates that are no longer active. Authored elapsed units resolve by the actor's location ancestry; absent calendar definitions require clarification.

## Pros and Cons of the Options

Fixed phrase matching is cheap but narrows open semantics and mistakes quotations or hypotheticals for actual events. A separate post-event call sees the final result but increases mandatory calls and encourages arbitrary checkpoint polling. Existing-batch matching retains open language and adds no separate call for an already adjudicated event. It increases question count with nearby conditional activities and requires strict delivery checks and candidate invalidation. It remains a semantic judgment that needs live qualification, not a claim of perfect interpretation.

## Links

- [Long activity contract](../specs/0198-long-activity-duration-and-interruption.md)
- [Interruption admission and cancellation](../../src/engine/direct/interruption.ts)
- [Real-entry long activity tests](../../src/engine/direct/__tests__/long-activities.test.ts)
- [Long activity and publication incident](../postmortems/0175-long-activity-conditions-and-publication-boundaries.md)
