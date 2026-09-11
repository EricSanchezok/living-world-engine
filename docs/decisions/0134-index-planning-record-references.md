# Index Planning Record References

## Status

Accepted
Class: feature

## Context and Problem Statement

A complete visible worklist and schema choice enums do not enforce generated ownership. Physical planning can repeat an action while omitting another, and an effect can select a visible entity absent from its plan's target set. Independent string copies encode relationships the decoder can restore exactly from explicit source selections.

## Decision Drivers

- Preserve arbitrary action semantics and every original candidate.
- Reduce copied opaque identifiers and dependent-field inconsistency.
- Keep semantic choices explicit and reject unsupported selections.
- Preserve immutable source binding and targeted repair evidence.

## Considered Options

1. Use source action and target indices with plan-local effect target positions.
2. Retain independent string references with only clearer repair feedback.
3. Add missing targets or deduplicate plans after generation.

## Decision Outcome

The opt-in representation in [0044](../specs/0044-source-indexed-planning-records.md) derives reference spelling and effect target membership from model-selected indices. A flat array retains explicit action ownership and avoids relying on JSON object duplicate-key handling. Existing field feedback remains useful for other representations and canonical validation. No runtime or semantic benefit is claimed before complete-source qualification.

## Pros and Cons of the Options

1. Short selections preserve the complete source vocabulary and make the effect-to-plan relationship mechanical. Indices depend on the exact request snapshot and repair scope; strict binding and fresh annotation are essential. The representation cannot guarantee valid modes, full coverage or semantic correctness from the model.
2. Located feedback is necessary but still leaves several copies of opaque identities and a model-repaired relationship. It can consume additional calls without addressing first-response structure.
3. Adding a target or choosing among duplicate plans makes an unrequested semantic decision. It can hide a model failure and change who an action affects.

## Links

- [NatSQL](https://aclanthology.org/2021.findings-emnlp.174/), simplified intermediate representation motivates mechanical restoration; its text-to-SQL results do not establish game-planning performance.
- [Worklist projection](0132-project-explicit-planning-worklists.md).
- [Dependent plan fields](0120-dependent-resolution-fields.md).
