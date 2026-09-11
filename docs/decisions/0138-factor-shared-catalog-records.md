# Factor Shared Catalog Records

## Status

Accepted
Class: simplification

## Context and Problem Statement

Transition batches expose many candidate records with repeated permission, type, meaning and visibility fields. Shared-state factoring deduplicates records between logical slots, while catalog-order prefix factoring removes repeated order lists. Neither removes equal fields repeated across distinct shared candidate records. These records must remain available in the original scope and rank.

## Decision Drivers

Preserve all original information and reference permissions, reduce repeated input, avoid a new semantic selection step and retain source-hash verification. Keep model output references unchanged.

## Considered Options

- Serialize each shared candidate record independently.
- Replace long reference handles with shorter aliases.
- Factor equal record fields into reusable templates.

## Decision Outcome

The experimental worklist factors shared catalog records into templates and original variable fields. [Specification 0059](../specs/0059-transition-catalog-records.md) owns the encoding. Expansion precedes existing slot reconstruction and hash verification; it does not add semantic data. The original codec remains a no-op result when no shared candidate map is present.

## Pros and Cons of the Options

Independent records are locally self-contained but repeat policy text. Reference aliases can remove more repeated characters across the context, but require additional handling for output references, embedded pointers and collision-free identity restoration. Record templates remove repeated policy fields while preserving original handles and output schemas. They require the model to combine a template with row-specific fields; correctness and efficiency therefore remain experimental questions.

## Links

- [Catalog-order prefix contract](../specs/0054-transition-catalog-prefix.md)
- [Record codec](../../src/engine/mechanics/shared-catalog-records.ts)
- [Source-selection contract](../specs/0057-transition-source-selections.md)
