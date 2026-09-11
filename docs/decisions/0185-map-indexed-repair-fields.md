# Map Indexed Repair Fields

## Status
Accepted
Class: testing

## Context and Problem Statement

Indexed planning emits targetIndices and effect targetPosition, while canonical schema rejection names targetRef. A failed selected position becomes an unresolved sentinel before logical repair. Complete canonical error evidence therefore does not directly identify the generated relation that failed. Repeating full generation without that mapping can preserve the same invalid relationship.

## Decision Drivers

- Diagnose the model's actual generated fields without choosing semantic targets.
- Preserve complete source context, original errors and accepted-value boundaries.
- Isolate recovery feedback from first-request and representation changes.

## Considered Options

- Keep only canonical field diagnostics.
- Add a source-bound mapping to the current indexed repair vocabulary.
- Infer missing target selections from effect prose.
- Replace the planning representation in the same experiment.

## Decision Outcome

Select the input-only diagnostic experiment in [0132](../specs/0132-indexed-target-repair-diagnostics.md). Match stable action identities across repair scopes; describe rejected positions without transferring their meaning to the current target domain. Keep the complete original evidence and original decoder. This separates an error-explanation hypothesis from a future representation change.

## Pros and Cons of the Options

### Canonical diagnostics alone

- Preserve the validator's exact responsibility.
- Leave the generated position and selected-list relationship implicit.

### Source-bound field mapping

- Exposes the deterministic relationship and current action scope without inventing a selection.
- Adds repair input and may fail to improve either recovery or semantic correctness.

### Infer selections

- Could make a malformed candidate parse.
- Assigns semantic meaning outside the model's explicit choices and hides failure.

### Simultaneous representation replacement

- Could reduce the dependency burden of first-pass generation.
- Prevents this comparison from isolating recovery feedback and requires a separate full-domain contract.

## Links

- [Indexed planning records](../specs/0044-source-indexed-planning-records.md)
- [Complete rejected-domain sharing](0160-share-complete-rejected-domains.md)
- [Synchromesh](https://arxiv.org/abs/2201.11227) distinguishes conceptual errors from syntax, scope and contextual constraints. This experiment does not implement its incremental constrained decoder or claim its reported benefits.
