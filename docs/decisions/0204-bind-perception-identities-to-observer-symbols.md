# Bind Perception Identities to Observer Symbols

## Status
Accepted
Class: testing

## Context and Problem Statement

Private perception claims use observer-owned local identities, while their trusted adjudicator receives all actors' complete evidence. A globally valid local handle can belong to the source actor instead of the observer. Exact canonical bindings cannot translate every such mistake: some referents are unbound, ambiguous or absent from the observer's inventory. Correcting a model's intended referent is a semantic decision.

## Decision Drivers

- Eliminate avoidable cross-owner reference construction without guessing identity.
- Preserve unknown appearances, explicit introductions and complete world semantics.
- Keep the original materializer and raw failures authoritative.
- Measure incremental behavior against a fixed representation and source.

## Considered Options

- Continue generating qualified handles from a global field domain.
- Translate foreign handles using canonical equivalence after generation.
- Select existing identities from a target-bound local symbol table.

## Decision Outcome

Select the benchmark codec specified in [0158](../specs/0158-observer-local-perception-symbols.md). An integer has meaning only within its assigned observer's complete ordered inventory. It restores one explicit existing handle, while a proposal remains an explicit model-authored introduction. The codec composes only with the pinned temporal route representation and changes no default algorithm. It prevents an accepted integer selection from resolving to another observer's identity; it does not prove that the selected referent or generated assertion is semantically correct.

## Pros and Cons of the Options

Global handles retain the existing syntax but allow the generator to select another actor's otherwise legal identity. Per-field global enumeration does not express ownership.

Canonical-equivalence translation can cover a subset of mistakes, but absent, unbound and ambiguous referents require additional semantic choices. Treating them as automatic repairs obscures the original failure and can create information that the observer never received.

Local symbols compile ownership from an explicit assignment and preserve the entire legal inventory. They require an additional table and decoder, and the model can still select the wrong in-scope referent or invert the task semantically. Full-source review and complete-player qualification remain necessary.

## Links

- [Field-domain specialization](0183-specialize-perception-report-field-domains.md)
- [Temporal route representation](0203-discriminate-perception-by-temporal-route.md)
- [Observer-bound onset receipts](../specs/0128-observer-bound-onset-receipts.md)
