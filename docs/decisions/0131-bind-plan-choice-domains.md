# Bind Plan Choices to the Actual Request

## Status

Accepted
Class: feature

## Context and Problem Statement

A selector's string pattern describes its spelling but not membership in the current request. Full planning contexts include available actions outside the assigned root and many other reference kinds. A model can emit a well-formed selector that has no legal binding, or produce additional plans for unassigned actions.

## Decision Drivers

- Preserve complete source information and open actions.
- Make finite existing choices explicit at the output boundary.
- Retain authoritative per-slot ownership and strict rejection.
- Avoid repeated large domain lists across plan alternatives.

## Considered Options

1. Bind exact root action and target domains through shared wire-schema definitions.
2. Keep string patterns and rely on further model repairs.
3. Guess nearest legal selectors or drop unassigned plans after generation.

## Decision Outcome

The opt-in wrapper enumerates complete assigned action and target selector inventories in the output schema under [0041](../specs/0041-source-bound-plan-choice-schema.md). Shared definitions avoid repeating inventories across mode alternatives. Existing decoders remain authoritative for narrower slot ownership and semantic fields.

## Pros and Cons of the Options

1. The output schema names actual choices without deleting context or generating action meaning. It adds schema tokens, and hosted JSON generation can still ignore constraints. A root-wide union is not proof of slot-level validity.
2. Patterns are compact but expose no membership information; repeated repair retains that ambiguity.
3. Post-hoc guessing can assign another entity or action and conceal semantic changes. Invalid choices must remain visible failures.

## Links

- [Flat source-bound plan grouping](0130-derive-plan-slot-wrappers.md).
- [Plan source selectors](../../src/engine/mechanics/plan-source-selectors.ts).
- [Canonical plan admission](../../src/engine/benchmarks/step-efficiency/resolution-admission.ts).
