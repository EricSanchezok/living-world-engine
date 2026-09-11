# Encode Planning Record Columns

## Status

Accepted
Class: architecture

## Context and Problem Statement

Planning responses repeat field names across actions, means, factors and typed source pairs. Merely ordering JSON object properties does not require a model to choose a mode before generating its dependent fields. Prose and evidence carry action meaning and cannot be discarded as serialization overhead.

## Decision Drivers

Preserve open semantics and all source values; reduce repeated output syntax; expose mode-dependent structure; keep full validation and independently diagnosable repair; measure the tradeoff for small non-thinking models.

## Considered Options

1. Keep named records and reorder schema properties.
2. Use schema-derived fixed columns for plans and repeated small records.
3. Shorten explanations or supply effects and sources deterministically.

## Decision Outcome

Offer an explicit fixed-column planning codec. The first two plan values identify mode and action. Column schemas retain all field constraints, and a trailing object retains optional plan fields. Only required null-only fields are implicit in their selected mode. Means, factors and typed source pairs use short tuples, while larger effect records keep field names. The canonical pipeline still validates decoded values and semantics. This saves repeated syntax at the cost of position-sensitive generation; prospective measurements determine adoption.

Identical schema subtrees are shared through local definitions to avoid repeating the same column and type declarations. Definition reuse changes no predicate and does not assume native constrained decoding support.

## Pros and Cons of the Options

Named records are readable but repeat output syntax and permit object-key order to vary. Fixed columns preserve all content and require structural ordering, but a wrong position can invalidate a row and must remain visible in repair evidence. Shortening prose or choosing effects in code could reduce more output, but changes semantic work and is outside this representation-only candidate.

## Links

- [Behavior contract](../specs/0115-compact-planning-records.md)
- [Indexed planning](../../src/engine/mechanics/source-indexed-planning.ts)
- [Source-bound repair reconstruction](0163-reconstruct-joint-plans-after-local-repair.md)
