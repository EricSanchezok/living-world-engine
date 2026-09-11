# Eligible temporal profile schema

## Status

Accepted
Class: feature

## Context and Problem Statement

The temporal representation advertises profile enums in the output schema while the request separately describes eligibility derived from exact action evidence. A model can select a profile that every slot rejects. Fixing that selection through repair can introduce a different, invalid continuation condition. The STEP-E1 report owns the observed failures and measured results.

## Decision Drivers

Preserve every legal temporal interpretation, all action text, candidate identities, full batch cardinality and the existing recovery bound. Keep the intervention explicitly selectable for a measured comparison.

## Considered Options

- Leave eligibility only in task data and rely on repair.
- Intersect the output profile enums with the union of trusted slot eligibility.
- Add typed fact snapshots to conditional assertions.

## Decision Outcome

The represented compiler accepts an optional `eligibleProfileSchema: batch-union-v1` Composition setting for temporal representations. It restricts the shared array-item schema to profiles eligible for at least one current request slot. The compiler retains per-slot eligibility and onset validation. Repair recomputes the union for its actual slots. The adapter fails before model HTTP when trusted eligibility is missing or the resulting set is empty. It does not change context, infer conditions, correct literal values or request native constrained decoding.

## Pros and Cons of the Options

The schema union removes choices that cannot pass any slot while retaining heterogeneous batches' legal choices. It cannot prevent one slot from selecting another slot's eligible profile, and JSON-object generation still requires actual response validation. Prompt-only eligibility retains contradictory choices in the schema. Snapshot encoding can avoid copying an available typed value but does not solve an ineligible temporal profile and cannot copy an undisclosed value from a label-only fact candidate.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Representation codec](../../src/engine/algorithms/eager-reference/action-compilation-representation.ts)
- [Compiler boundary regression](../../src/engine/algorithms/eager-reference/__tests__/represented-action-compiler.test.ts)
