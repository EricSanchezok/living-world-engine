# Isolate canonical plan-cause references

## Status

Accepted
Class: architecture

## Context and Problem Statement

The indexed planner uses action-local means positions and a global cause domain. Equal integers can refer to different sources, while the decoder correctly preserves the selected coordinates. A broad canonical-reference ablation changes several independent constraints and cannot isolate cause spelling.

## Decision Drivers

- Preserve complete legal evidence choices and original semantic authority.
- Measure one reference-field change without adding model calls or source inference.
- Retain failed outputs and distinguish transport equivalence from model quality.

## Considered Options

1. Translate explicit canonical cause references through the complete existing cause domain in a benchmark adapter.
2. Disable cause indexing throughout the planning stack.
3. Remove the complete indexed representation stack.
4. Guess intended causes from means descriptions or replace invalid source authority.

## Decision Outcome

The benchmark uses an outer reversible causeRefs representation while retaining canonical targets, action-local means, factor types, dependent fields and the complete cause table. The adapter restores exact indices for the existing cause decoder. Instruction accessors let it replace the owned user clause and final-tail clause without duplicating their source strings. [Spec 0172](../specs/0172-canonical-cause-planning-screen.md) owns the contract. No registered runtime default selects the adapter.

## Pros and Cons of the Options

1. Explicit references remove a numeric coordinate from model output and isolate cause spelling. They add tokens and do not guarantee relevant evidence selection.
2. Disabling indexing also breaks the tail and source-domain contracts that require the complete cause projection; it does not preserve this baseline.
3. Broad removal also changes targets, means and factor representations, obscuring which constraint affects quality.
4. Inferred correction changes model-owned evidence or authority and can conceal multiple independent errors in one plan.

## Links

- [Canonical cause adapter](../../src/engine/benchmarks/step-efficiency/canonical-planning-causes.ts).
- [Original cause decoder](../../src/engine/mechanics/source-indexed-plan-causes.ts).
- [Canonical target screen](0215-use-canonical-targets-in-indexed-planning-screen.md).
