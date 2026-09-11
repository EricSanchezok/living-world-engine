# Align perception reference contracts

Artifact-Version: 1
Status: Approved

## Intent

Align perception's advertised choices with its existing executable check contract under the continuing autonomous gameplay optimization authorization. A model must not be offered an Agent or local name as a check entity. This is a contract repair, not an increase in model reasoning or a change to world semantics.

## Contract

Check actors and non-null targets select existing entity handles. Actor entities must be active. Non-null actor ratings and modifier sources select existing rating handles; rating ownership and exact modifier amounts remain mechanically checked. Causes select current actions, already committed perception checks, existing events, facts or authored laws. Same-response proposals, discrete random results and mechanics are not perception causes. Each commitment round resolves the same committed check inventory that its context exposes.

The perception catalog retains every row, handle, label, meaning and state path. Only unsupported field uses are removed and the catalog hash is recomputed. Shared cached projections and other Truth stages retain their own uses. Complete action text, local-object descriptions, canonical state and repair evidence remain available. No local identity is automatically bound to a canonical entity, no target is replaced with null, and no required check is replaced with completion. Models still decide check intent, stakes, target and whether checks are needed.

Prompt, schema and catalog hashes identify the changed request contract. The public game API, batch sizes, repair bounds, random procedure, thinking setting and budget remain unchanged. Runtime validation remains authoritative even when a provider ignores schema constraints.

## Plan

Reuse typed reference schemas and a shared perception cause inventory. Project supported catalog uses without mutating cached Truth context, and refresh the runtime resolver at each commitment round. Verify saved failure shapes through the real perception entry before freezing a narrow paid diagnostic.

## Verification

Test Agent/local/proposal rejection at precise field paths, exact legal materialization, null targets, rating ownership and amounts, missing handles, prior-round check causes, unchanged source state and random commitments after rejection, complete repair evidence and unchanged other-stage catalogs. Run relevant tests and check:fast before committing. Report contract evidence separately from model success and complete action-to-feedback latency.

## Evidence

The [perception reference scope](../../src/engine/contracts/perception-references.ts) binds the advertised cause inventory to runtime validation. [Perception regressions](../../src/engine/mechanics/__tests__/perception-references.test.ts) exercise the real check entry, schema and context. The [incident report](../postmortems/0105-perception-reference-contract-mismatch.md) records the escaped mismatch.
