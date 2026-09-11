# Intern exact observation action sequences

## Status

Accepted
Class: simplification

## Context and Problem Statement

Shared observation contexts repeat complete action arrays in assigned, available and initial sets. Observer-local reference differences prevent equality factoring of whole arrays even when most individual records are identical. Large batches therefore repeat the same source text and references many times.

## Decision Drivers

- Preserve every source action, record field, sequence order and observer-specific reference.
- Reduce measured repetition without changing observation responsibility or output semantics.
- Validate reconstructed contexts through their original hashes and reference permissions.
- Keep representation experiments separate from production admission and player task completion.

## Considered Options

1. Intern exact complete records and ordered sequences in an opt-in observation input dictionary.
2. Retain whole-array equality factoring and change only serialization order for prefix caching.
3. Drop actions judged irrelevant or merge records by action identity.

## Decision Outcome

The experiment stores each distinct complete action record once and each distinct ordered sequence of record indices once. Only the established action-set paths use sequence pointers; other source fields remain intact. Records with equal action identities and different local references remain distinct. Expansion restores every occurrence before the existing shared-context hash checks. Original schema, decoder, materialization and information checks remain authoritative. The [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns experimental acceptance; runtime defaults do not select this codec.

## Pros and Cons of the Options

1. Exact record interning preserves the complete source and avoids repeated storage across nonidentical arrays. The model must interpret two levels of dictionary references, so deterministic round trips alone cannot establish semantic performance.
2. Prefix layout can improve reuse of identical leading input but leaves repeated tokens within each request. It remains an independent performance hypothesis.
3. Relevance pruning changes available evidence; merging by identity can erase observer-local differences. Neither is an exact representation of the source contract.

## Links

- [Shared context expansion contract](0166-bound-shared-context-expansion-reuse.md).
- [Observation dictionary experiment](../../src/engine/benchmarks/step-efficiency/observation-action-dictionary.ts).
- [Complete observation entry probe](../../scripts/experiments/player-observation-dictionary-probe.ts).
