# Select Perception Ratings With Their Owners

## Status
Accepted
Class: architecture

## Context and Problem Statement

Independent observer and Rating fields can each name a real object while forming an invalid pair. Repair can replace the mismatch with a plausible but nonexistent Rating name. The execution contract already requires ownership; asking a model to reconstruct that relation duplicates a deterministic state fact.

## Decision Drivers

- Preserve every legal observer, aptitude and opposed-difficulty selection.
- Keep world meaning, sensory access and justified uncertainty model-owned.
- Validate through the existing gateway, materializer and repair path.

## Considered Options

- Strengthen prose around independent fields.
- Infer an intended Rating or substitute null after rejection.
- Expose explicit state-bound owner-and-Rating choices as an optional representation.

## Decision Outcome

The optional representation exposes legal tuples directly. A selected tuple mechanically restores its exact references; explicit no-aptitude choices remain available. The default is not changed by registering the candidate. Model and gameplay acceptance are governed by the [experiment contract](../specs/0106-bound-perception-rating-choices.md).

## Pros and Cons of the Options

Prose retains the same relational reconstruction burden. Inference or null substitution changes a model's declared check meaning. Explicit tuples remove impossible combinations but add input indirection and require empirical semantic and latency validation. They do not provide constrained decoding or guarantee the model selects the appropriate tuple.

## Links

- [Synchromesh](https://arxiv.org/abs/2201.11227) distinguishes program intent from syntax, scope and typing constraints. This adapter borrows that distinction; it does not implement its decoding controls or example retriever.
- [Perception numeric ownership](../specs/0103-derive-perception-check-numbers.md).
