# Share compilation field-use domains

## Status

Accepted
Class: architecture

## Context and Problem Statement

Action Compilation uses short request-local aliases for both Agents and canonical state records. A syntactically valid alias can have the wrong field use. The compiler rejects these errors after generation. Per-slot schema specialization can repeat large reference domains across a physical batch; hosted JSON mode does not provide token-level semantic decoding control.

## Decision Drivers

- Preserve every legal choice in the current visible source and each original physical batch.
- Express type and use constraints without guessing Entity/Agent bindings or rewriting output.
- Retain source state, original schema predicates and per-slot materialization authority.
- Measure representation cost and model behavior before runtime adoption.

## Considered Options

1. Add shared field-use union definitions to the existing AT wire schema in an isolated experiment.
2. Select the existing per-slot constrained schema and snapshot representation together.
3. Keep generic alias patterns and rely on prose plus downstream repair.
4. Replace wrong-type references with a guessed corresponding identity.

## Decision Outcome

The experiment retains the AT array structure and specializes the two state-dependency arrays, audience and resource-pool fields using the existing validator's type/use contracts. Domains are the complete union of candidates visible to any current slot, represented once in schema definitions. Original field predicates remain conjuncts; empty item domains do not prevent empty arrays. The original per-slot validators still determine legal membership and materialization. Each request, including recovery, derives its own domains and binds its source. Runtime defaults do not select the adapter. The [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns the prospective comparison and acceptance boundary.

## Pros and Cons of the Options

1. Shared domains avoid per-slot duplication and retain all original output fields. JSON-mode schema guidance can still be ignored or semantically misapplied; legality does not establish relevance or goal completion.
2. Per-slot schemas can express tighter membership and explicit snapshots can reduce copying, but changing both structures prevents isolation of the observed field-use failure and can repeat large domains. Their independent experimental evidence remains authoritative.
3. Generic patterns keep schemas small but leave a known type/use distinction implicit until validation and repair.
4. Guessing corresponding identities changes the model's choice, can bind ambiguously, and conceals the original failure. It violates explicit selection and source authority.

## Links

- [Compilation field contracts](../../src/engine/algorithms/eager-reference/action-compilation-validation.ts).
- [Field-domain adapter](../../src/engine/benchmarks/step-efficiency/compilation-field-domains.ts).
- [Actual compiler comparison](../../scripts/experiments/player-compilation-field-domains.ts).
- [Constrained first-pass experiment](../specs/0024-action-compilation-constrained-first-pass-experiment.md).
- [Synchromesh: Reliable Code Generation from Pre-trained Language Models](https://arxiv.org/abs/2201.11227) motivates separating syntax, scope and contextual typing. Its completion engine controls token sampling; this adapter does not implement that decoding algorithm or inherit its guarantee.
