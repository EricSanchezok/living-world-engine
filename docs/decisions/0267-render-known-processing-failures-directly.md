# Render known response-processing failures directly

## Status
Accepted
Class: simplification

## Context and Problem Statement

A related character's response can fail before any new speech or physical result commits. The engine already knows this processing boundary and the participant's local identity for the responder. Creative recovery prose can confuse that responder with the original addressee, dramatize uncommitted speech, or ask the player to repeat completed work. Checking and repairing that text spends model calls without adding a world result.

## Decision Drivers

- Preserve the actual failed subject and all earlier completed outcomes.
- Avoid invented world behavior when explaining a processing status.
- Eliminate model work whose complete factual content is already structured.
- Preserve narrative freedom and publication checks for actual events and explanations.

## Considered Options

- Continue generating and reviewing every recovery notice.
- Render all recoveries and semantic explanations from templates.
- Render only fresh, known-focus response failures with no new observation or speech directly.

## Decision Outcome

Choose the third option under [Spec 0206](../specs/0206-direct-known-response-failure-feedback.md). The engine-owned status uses the known local focus, retains ordered persistence and records no model producer. Other recoveries and all world events retain their existing semantic and creative paths. Existing prose remains immutable; a terminal fallback may append the missing factual notice without rewriting its prefix. This narrows the recovery exception to creative narration in [0234](0234-delivered-dialogue-and-receipt-only-narration.md).

## Pros and Cons of the Options

- Generating every notice permits varied phrasing, but adds no authoritative information and introduces avoidable attribution and retry errors.
- Templating all recoveries avoids these calls, but loses useful interpretation of partial outcomes, ambiguity and player questions.
- The narrow direct path is plain processing feedback and cannot provide a tailored next step. It preserves exact attribution without guessing whether the player still has work to do, while actual scene prose keeps its existing expressive range.

## Links

- [Recovery failure evidence and guardrails](../postmortems/0197-recovery-attribution-and-unobservable-manner.md)
- [Narrative lifecycle](../game-design/narrative.md)
- [Direct established dialogue](0234-delivered-dialogue-and-receipt-only-narration.md)
