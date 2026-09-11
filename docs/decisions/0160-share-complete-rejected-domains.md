# Share Complete Rejected Domains in Repair

## Status
Accepted
Class: architecture

## Context and Problem Statement

A malformed indexed plan can carry its complete rejected cause domain both in the previous output and in multiple validation issues. Repeating the same inventory consumes context without supplying additional evidence. Bisection cannot remove duplication within one logical repair slot.

## Decision Drivers

- Retain complete current and historical evidence and exact index interpretation.
- Keep invalid selections invalid and retain independent slot recovery.
- Reduce redundant context without changing world activity, batch cardinality or model settings.

## Considered Options

- Remove rejected domains or keep only selected rows.
- Increase limits or subdivide logical work.
- Pool complete repeated diagnostic domains with explicit reconstruction paths.

## Decision Outcome

The optional planning representation pools identical historical cause-domain arrays within physical repair context. A content-addressed table and source paths preserve every occurrence. Inverse reconstruction verifies both individual domains and the complete source state. The model sees the decoding contract and the entire table; historical pool rows are evidence, not current permissions.

## Pros and Cons of the Options

Removing unselected historical rows is smaller but weakens the complete rejected-domain contract. Larger limits are bounded by the provider, and subdivision adds calls without fixing duplication inside one slot. Exact pooling removes duplicated bytes while preserving evidence, at the cost of an input indirection that requires separate model and gameplay validation.

## Links

- [Rejected-domain sharing contract](../specs/0099-share-rejected-cause-domains.md).
- [Source-indexed plan causes](0149-index-existing-plan-causes.md).
- [Shared planning catalog encoding](../specs/0095-shared-planning-catalog-encoding.md).
