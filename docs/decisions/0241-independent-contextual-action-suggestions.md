# Independent contextual action suggestions

## Status
Superseded by [0242](0242-on-demand-published-context-suggestions.md)
Class: architecture

## Context and Problem Statement

Action suggestions must follow the participant's current decision point, including entry and turns delivered directly as dialogue. Arrival text persists as an opening, while narration publishes world results and may bypass creation for already delivered speech. Neither is a reliable owner for current action suggestions.

## Decision Drivers

- Keep input responsive and world execution independent of presentation failure.
- Respect the current character's knowledge and control ownership.
- Bound additional model work and retain complete evidence.
- Keep one current source of suggestions across refresh and restart.

## Considered Options

- Rotate a client-side library of generic suggestions.
- Ask Arrival and narration to append suggestions to their prose outputs.
- Generate an independent asynchronous batch at each stable decision point.

## Decision Outcome

Choose independent generation under [Spec 0188](../specs/0188-contextual-action-suggestions.md). A server module owns authorized context and one creation-profile call for the entire batch. WorldHost coordinates task ownership and saves; each Participant stores one current record. The public conversation projects only the ready batch. Source fencing discards stale completions, and interrupted or failed batches remain absent without automatic retries. The world and narrative contracts do not depend on suggestion success.

## Pros and Cons of the Options

- Client rotation is cheap but cannot reliably reflect completed actions, dialogue or character goals.
- Coupled prose output saves a call when prose generation is needed, but blocks suggestions on narration and misses direct dialogue paths. It also assigns current decisions to immutable opening content.
- Independent generation works at every decision point and isolates optional failures. It costs at most one additional logical creation request per point and needs explicit invalidation, persistence and late-result fencing. There is no additional semantic repair call or fixed fallback.

## Links

- [Presentation contract](../game-design/presentation.md#情境行动建议)
- [Architecture](../architecture.md)
