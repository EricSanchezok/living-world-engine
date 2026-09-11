# Explicit unconfirmed observation branch

## Status

Accepted
Class: feature

## Context and Problem Statement

An observation can state that receipt or reply is unknown while giving the same proposition a Boolean false value. Valid identities and event citations do not detect this contradiction. The public belief value union represents text, quantities, Boolean values, local entities and absence; it has no dedicated epistemic unknown value.

## Decision Drivers

Preserve open semantics and cognitive isolation, keep public game contracts stable, avoid natural-language heuristics, and test a concrete representation change without adding model calls or reasoning effort.

## Considered Options

- Repeat prose instructions while retaining only the existing claim shape.
- Rewrite Boolean values after detecting uncertainty words in descriptions.
- Extend the public belief value union with a dedicated unknown variant.
- Provide an opt-in tagged observation-output branch and materialize explicit uncertainty as ordinary descriptive text.

## Decision Outcome

The experimental observation encoding requires the model to select an asserted or unconfirmed branch. Asserted values remain unchanged. An unconfirmed branch has no value field and materializes its complete description with an explicit uncertainty label as a text-valued apparent claim. The engine renders the model's decision; it never decides that a Boolean was intended as unknown. Existing canonical schemas and public APIs remain unchanged.

## Pros and Cons of the Options

Prompt repetition leaves the representation ambiguity in place. Keyword-based rewriting can misread negation and silently change an intentional false claim. A dedicated public unknown value offers stronger domain typing but changes the public contract and downstream consumers. The selected experimental branch provides an explicit generation choice within the current contract, but its resulting text remains subject to model interpretation and does not prove source entailment. A model can still choose the wrong asserted branch; source-based evaluation remains required.

## Links

- [Contract and verification](../specs/0094-unconfirmed-observation-claims.md)
- [Observation-intent failure](../postmortems/0102-observation-intents-reported-as-results.md)
- [Evidence-first layout](../specs/0093-evidence-first-observation-layout.md)
