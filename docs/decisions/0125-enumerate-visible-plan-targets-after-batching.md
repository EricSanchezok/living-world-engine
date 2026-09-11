# Enumerate Visible Plan Targets After Physical Batching

## Status

Accepted
Class: architecture

## Context and Problem Statement

Truth plans select existing entity targets, but a syntactically valid reference prefix does not establish catalog membership. A nonthinking model can invent a plausible entity handle even when the complete catalog is visible. Generic repair must then spend a new request or reject the atomic step. Different logical catalogs also make early request-specific schemas a potential source of batch fragmentation.

## Decision Drivers

- Preserve arbitrary actions and every currently legal entity choice.
- Reduce observed invented references without mapping them to guessed entities.
- Preserve physical batch cardinality, canonical validation and slot isolation.
- Measure schema overhead and hosted-model behavior before runtime promotion.

## Considered Options

1. Enumerate the current visible target vocabulary after physical batching.
2. Specialize each logical request schema before batching.
3. Replace unknown handles with the closest catalog label.
4. Rely exclusively on the generic reference pattern and repair text.

## Decision Outcome

The opt-in physical provider adapter enumerates the sorted union of current target-eligible entity handles in plan target arrays. It composes after dependent-field wire encoding and leaves the canonical schema, context and output unchanged. Shared-context expansion proves each source slot binding before vocabulary collection. Canonical per-slot resolution retains scope authority: the union avoids removing legal choices but does not broaden a slot's allowed catalog. [Spec 0035](../specs/0035-visible-plan-target-vocabulary.md) bounds evaluation and promotion.

## Pros and Cons of the Options

1. The physical vocabulary makes exact choices local to the output field and retains batching. It adds schema tokens, relies on hosted-model adherence and can still require scope repair for a choice belonging to another slot.
2. Logical specialization can encode narrower domains, but differing schemas can split otherwise compatible physical work and increase calls.
3. Fuzzy replacement can hide invalid outputs by changing the selected world object and is incompatible with semantic preservation.
4. Generic patterns have minimal schema size but leave membership implicit in a large context and retain the demonstrated failure mode.

## Links

- [First principles](0004-game-first-principles.md).
- [Reviewed Truth transport](0124-compose-reviewed-truth-transport-for-playtests.md).
- [Shared context codec](../../src/engine/mechanics/shared-batch-context.ts).
