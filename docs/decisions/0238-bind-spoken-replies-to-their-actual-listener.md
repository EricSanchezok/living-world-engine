# Bind spoken replies to their actual listener

## Status
Accepted
Class: architecture

## Context and Problem Statement

Autonomous action choice and open dialogue creation use the same private evidence but occur at different boundaries. A proposed listener can disagree with the person addressed by the generated words. The [continuity regressions](../research/2026-10-14-conversation-continuity-regressions.md) retain an observed instance of that disagreement. A failed relevant reply also needs a participant-visible explanation without exposing the character's unexecuted intention.

## Decision Drivers

- Bind words and listener coherently before world delivery.
- Preserve local identity and private cognition boundaries.
- Keep failure recovery bounded and retain already committed interactions.
- Avoid a mandatory additional semantic review request for every reply.

## Considered Options

- Keep the earlier listener binding immutable and rely on wording instructions.
- Generate words, then adjudicate their listener in another model request.
- Let the existing expression request bind its actual listener alongside the words.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). An autonomous spoken expression may bind an actual listener from the actor's authorized local recipient catalog, or broadcast. Code resolves that key and constructs one ActionFrame before world adjudication and delivery. Omission retains the proposed listener. Player-controlled expressions and other action kinds retain their existing bindings. The expression cannot grant knowledge or make its words true.

Malformed expression output receives one targeted format correction against the same context. Explicit null speech remains intentional silence; an empty object is incomplete output. A transport or service failure does not enter this correction loop. Completed attempts retain distinct audits, while transport failures retain their ordinary gateway evidence.

A newly failed NPC task directly caused by a participant's committed action registers a recovery narrative for that submission. It explains the response-processing interruption and preserves earlier receipts. Background task failures do not create such feedback. The explanation cannot invent a refusal, private intent, physical cause or missing delivery; service pauses use the separate factual and status path.

## Pros and Cons of the Options

- Immutable proposed listeners retain a simple division of roles but leave wording and delivery vulnerable to disagreement.
- A subsequent listener review can catch disagreement but introduces an extra dependent request and another failure boundary.
- Binding the listener with the words uses the existing creation request and resolves one coherent expression. It gives creation limited action-parameter authority within a supplied catalog; semantic reliability still requires full continuous-play qualification.

## Links

- [Narrative and creative authority](../game-design/narrative.md)
- [Direct runtime](../game-design/direct-runtime.md)
- [Frozen evaluation protocol](../research/2026-10-14-conversation-continuity-protocol.md)
