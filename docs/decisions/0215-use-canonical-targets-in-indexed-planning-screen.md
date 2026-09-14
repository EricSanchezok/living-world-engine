# Use canonical targets in an indexed planning screen

## Status

Accepted
Class: architecture

## Context and Problem Statement

Plan targets and effect subjects use two numeric coordinate systems. A broader canonical-reference ablation also removes action, means and factor constraints, preventing attribution to target spelling. The benchmark needs a narrower comparison that preserves the existing validated planning pipeline.

## Decision Drivers

- Preserve complete legal choices, original action meaning and canonical ownership.
- Isolate target spelling while retaining independent structural constraints.
- Avoid adding model calls or treating schema instructions as enforced decoding.

## Considered Options

1. Use canonical targetRefs and effect targetRef in a benchmark adapter over the indexed planner.
2. Remove the complete planning representation stack.
3. Nest effects inside target records.
4. Guess an entity from effect prose or repair a mismatched meter by moving the effect.

## Decision Outcome

The benchmark uses direct canonical target references while retaining action indices, per-action means positions, factor types, cause indices, source context and canonical validators. It restores exact source indices for the existing decoder. Repeated references remain ordered; effect ownership refers to the entity, so selecting its first occurrence preserves the canonical result. Invalid selections remain rejected and cannot change valid neighbors. [Spec 0169](../specs/0169-canonical-target-planning-screen.md) owns the screen contract. No registered runtime default selects it.

## Pros and Cons of the Options

1. Direct references remove the effect-position indirection and isolate two target fields. They can increase token cost and do not guarantee that the model selects the relevant entity.
2. Broad ablation makes fewer reference transformations but simultaneously removes useful constraints and obscures the comparison.
3. Structural nesting expresses ownership but changes more of the output shape and requires additional effect-role constraints.
4. Inferred repair changes the selected subject without model adjudication and can conceal a semantic error.

## Links

- [Indexed planner](../../src/engine/mechanics/source-indexed-planning.ts).
- [Canonical target adapter](../../src/engine/benchmarks/step-efficiency/canonical-planning-targets.ts).
- [Target-owned effect screen](../../src/engine/benchmarks/step-efficiency/target-owned-plans.ts).
