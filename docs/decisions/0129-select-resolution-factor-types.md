# Select Resolution Factor Types

## Status

Accepted
Class: simplification

## Context and Problem Statement

Resolution factors combine authority, role, direction and steps. Some fields are fixed by the chosen type, while others express independent semantic or numeric choices. Requiring every fixed field repeatedly creates contradictory outputs such as a numeric risk note without adding valid expressiveness.

## Decision Drivers

- Preserve every legal canonical factor and its evidence.
- Reduce redundant generation for non-thinking models.
- Keep numeric influence distinct from nonnumeric explanation.
- Reject contradictions instead of silently correcting their meaning.

## Considered Options

1. Use a reversible explicit factor type with only independent fields.
2. Keep all canonical fields and add more reminders or repair calls.
3. Infer the intended factor type or overwrite conflicting fields after generation.

## Decision Outcome

The opt-in codec derives typed wire alternatives from the canonical schema and restores only their literal constants. [Spec 0039](../specs/0039-resolution-factor-types.md) owns the contract. Runtime defaults and semantic adjudication remain unchanged pending prospective evidence.

## Pros and Cons of the Options

1. Every canonical valid choice remains representable and testable. The model still needs to choose the correct factor meaning; representation alone cannot prove that choice correct.
2. Repeated instructions retain cross-field coordination work and repairs add cost without ensuring a faithful correction.
3. Automatic reinterpretation can convert an intended penalty into a note or grant authored authority without support, crossing the strict-commit boundary.

## Links

- [Canonical resolution schemas](../../src/engine/contracts/llm-schemas.ts).
- [Dependent-field representation](../../src/engine/mechanics/resolution-dependent-fields-codec.ts).
- [Game first principles](0004-game-first-principles.md).
