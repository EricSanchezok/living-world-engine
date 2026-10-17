# Participant replies and background conversation

## Status
Accepted
Class: architecture

## Context and Problem Statement

Nearby witnesses retain delivered dialogue and may respond to it. Waiting for every such reaction to settle makes a participant's next turn depend on conversations between other characters. A dialogue chain can remain relevant to its participants while the human already has the requested answer.

## Decision Drivers

- Preserve observed speech, independent character activity and the canonical timeline.
- Finish the player's immediate feedback after their requested result and direct responses.
- Retain explicit follow-through such as delivery after a spoken acceptance.
- Avoid an arbitrary maximum number of conversational turns.

## Considered Options

- Drain every awakened character until the world becomes conversationally quiet.
- Stop all reactions after a fixed count or wall-clock limit.
- Separate direct participant responses from background conversation using recorded action causality.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). A ready or active character task whose selected or queued cause is a participant submission holds that submission's feedback window. Its explicitly continued work retains the same cause. Observing another character's subsequent action creates background work without extending the participant's immediate turn. That observation remains in private memory and the task remains scheduled. Delivered causes are queued independently of the active activity's cause, so neither older work nor a later observation displaces a player request. Ready selection prioritizes participant causes while retaining deferred background work. Already admitted activities retain their ordered world-time settlement. Human-controlled actors retain received evidence rather than an autonomous response backlog.

## Pros and Cons of the Options

- Global quietness is simple but lets unrelated exchanges delay the player's next choice indefinitely.
- A fixed cap bounds delay but cuts off relevant fulfillment and makes dialogue depth an arbitrary execution rule.
- Causal foreground selection preserves direct fulfillment and leaves other conversation resumable. It requires the host and engine to share the same classification and does not promise that all indirect social consequences finish before the next player turn.

## Links

- [Direct runtime](../game-design/direct-runtime.md)
- [Open creation and durable narration](0229-open-creation-and-durable-narration.md)
