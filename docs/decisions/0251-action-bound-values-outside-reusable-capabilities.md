# Action-bound values outside reusable capabilities

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

A reusable capability describes a method and its general consequences. An edited document or an accumulated qualitative record instead needs the concrete text resulting from one particular action. Using a reusable literal effect for that value permits generic completion descriptions and can overwrite a later edit with an earlier result. The finite decision catalog can select supplied values but cannot author arbitrary missing text.

## Decision Drivers

- Store actual content while preserving open action semantics and cognitive isolation.
- Keep the transaction kernel responsible for canonical commits and the full world decision responsible for meaning.
- Preserve existing batch and call counts where the missing value already requires creation.
- Keep action-specific content out of reusable capability definitions and avoid save migration.

## Considered Options

1. Tighten each world's document descriptions while retaining literal reusable effects.
2. Generate concrete existing-property values as action-bound proposals, with complete world review.
3. Reconstruct or append content deterministically after model adjudication.

## Decision Outcome

Choose action-bound proposals. Existing text properties selected as requiring a new value receive concrete candidate replacements using the actual action, current text and the author's evidence. Their admission shares the existing complete world decision batch. New concepts remain reusable; a mixed request returns its declaration separately in the same creation call. The [specification](../specs/0195-action-bound-text-values.md) owns the behavioral contract.

This gives up the small context used by the reusable declaration call: document authorship requires real evidence. It does not add a creation call for the normal missing-value case or broaden a character's access to another mind.

Prepared actions bind original and proposed value hashes to separate visibility decisions. Settlement uses the decision for the actual committed value, including when a resource conflict cancels the proposed replacement. This adds one required control-state field instead of treating visibility of a fact identity as visibility of all its possible values. The producer and control-state identities reject obsolete preparations.

## Pros and Cons of the Options

World-only descriptions are small and game-specific, but cannot supply omitted source evidence or prevent a reusable literal from overwriting a later edit. A recorded real-model variant still produces a meta-description.

Action-bound proposals retain semantic freedom, explicit evidence and world review. They require a distinct candidate schema and careful conflict handling with reusable effects.

Deterministic reconstruction is inexpensive but invents a second semantic author outside adjudication, cannot generally distinguish append from correction or deletion, and would turn player text into a state patch.

## Links

- [Direct world runtime](../game-design/direct-runtime.md)
- [Action-bound text specification](../specs/0195-action-bound-text-values.md)
- [Open values and published continuations](0237-open-values-and-published-continuations.md)
- [Concrete property-value creation](../../src/engine/direct/property-values.ts)
- [Capability creation](../../src/engine/direct/capabilities.ts)
- [World adjudication and materialization](../../src/engine/direct/world.ts)
- [Escaped placeholder-write failure and guardrails](../postmortems/0176-document-writes-became-reusable-placeholders.md)
