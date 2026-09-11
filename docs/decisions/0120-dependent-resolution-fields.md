# Represent independent resolution choices and derive their fixed copies

## Status
Accepted
Class: simplification

## Context and Problem Statement

Valid canonical plans require base magnitude to equal the primary effect magnitude and opposed difficulty source to cite the selected rating. These repeated values add no independent choice. Requiring a model to repeat them consistently introduces rejection opportunities. Rejecting an exactly equal optional copy also creates avoidable repairs when canonical input examples contain it. Schema-admitted effect shapes can additionally contradict the real execution requirements.

## Decision Drivers

- Preserve action semantics and every independent choice accepted by the execution rules.
- Remove representational contradictions without interpreting conflicting model intent.
- Keep one experimental implementation, physical batching and complete canonical validation.

## Considered Options

- Require all redundant copies and rely on repair instructions.
- Omit dependent fields and reject every explicit duplicate.
- Omit required duplicates, accept only exact redundant copies, and expose kernel shape constraints in the candidate schema.

## Decision Outcome

The `dependent-fields-truth-resolution` candidate uses a physical wire adapter that derives base magnitude and opposed rating source from the model's mandatory independent selections. Optional copies must match exactly. The encoder refuses inconsistent canonical input, so historical contradictions cannot become retrospective successes. Blocked and check wire shapes reflect existing kernel restrictions; the canonical materializer still owns final admission. The adapter leaves the input context, batching and unrelated fields unchanged.

The representation replaces [0112](0112-single-magnitude-resolution-wire.md) as one candidate implementation. It does not promote the candidate to the default or reinterpret a persisted Composition. Raw wire and expanded canonical output remain distinguishable in model audit evidence.

## Pros and Cons of the Options

### Require every copy

- Uses the canonical structure directly.
- Requires the model to solve equality constraints that add no expressive power and can consume bounded repair.

### Reject all explicit duplicates

- Defines a minimal output language.
- Treats a consistent copy as a failure despite having a unique, lossless interpretation.

### Derive fixed copies and accept exact redundancy

- Preserves independent choices and rejects conflicting interpretations without guessing.
- Avoids repairs for consistent copies and describes already required effect shapes earlier.
- Requires codec and gateway evidence; it cannot establish semantic correctness or native schema enforcement and does not solve wrong rating ownership or repeated evidence roles.

## Links

- [Approved experiment contract](../specs/0030-dependent-resolution-fields-experiment.md)
- [Canonical plan validation](../../src/engine/mechanics/resolution.ts)
- [Physical representation adapter](../../src/engine/mechanics/resolution-dependent-fields-codec.ts)
