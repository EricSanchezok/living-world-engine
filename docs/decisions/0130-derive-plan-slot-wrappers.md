# Derive Plan Slot Wrappers From Assigned Actions

## Status

Accepted
Class: simplification

## Context and Problem Statement

A physical planning response nests slots, results and plan lists. Every plan already contains an action reference whose logical owner is fixed in the request. Prematurely closing one nested list can make all following plans structurally unusable even when individual plan objects are readable.

## Decision Drivers

- Preserve full logical batches and open action content.
- Remove repeated model-generated routing information.
- Keep canonical slot validation and semantic ownership.
- Avoid ambiguous reconstruction of malformed historical JSON.

## Considered Options

1. Request a flat plan list and derive wrappers from the frozen action-to-slot map.
2. Keep nested output and spend additional repairs on bracket placement.
3. Reconstruct malformed historical fragments using inferred grouping.

## Decision Outcome

The opt-in physical codec groups newly generated plans solely by their explicit existing action references. It changes no plan meaning or source context. [Spec 0040](../specs/0040-flat-resolution-plan-batches.md) owns the invariants and prospective evaluation.

## Pros and Cons of the Options

1. Wrapper metadata becomes deterministic and every valid canonical response remains expressible. Unknown or missing action ownership must reject the entire physical response, so partial salvage can be worse for that error class.
2. Additional repair keeps the same structural burden and does not establish faithful semantics.
3. Fragment reconstruction can silently choose an unintended owner or discard a correction. A syntactically plausible wrapper is insufficient evidence of the intended grouping.

## Links

- [Physical Truth batching](../../src/engine/mechanics/truth-batch-provider.ts).
- [Source-bound admission](../../src/engine/benchmarks/step-efficiency/resolution-admission.ts).
- [Game first principles](0004-game-first-principles.md).
