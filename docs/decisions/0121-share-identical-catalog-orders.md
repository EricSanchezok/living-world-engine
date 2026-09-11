# Share identical reference catalog ordering data

## Status
Accepted
Class: simplification

## Context and Problem Statement

Shared truth batches already factor equal candidate values, but `shared-json-v2` repeats the complete candidate order in each slot. Equal order arrays carry no additional information. Removing ordering entirely would change the logical context, and combining candidates across slots would change reference scope.

## Decision Drivers

- Preserve every original logical envelope, candidate permission and candidate order.
- Reduce redundant input without shrinking actions, batches or state.
- Compare a separately frozen layout candidate before changing a game Composition.

## Considered Options

- Keep an inline order array in every slot.
- Remove order information or give every slot a union catalog.
- Intern exact order arrays in a shared dictionary and reference them per slot.

## Decision Outcome

The opt-in `shared-json-v3` layout interns identical catalog orders under deterministic keys. Each slot references its own order. Different sequences remain separate, even when they contain the same handles. Reconstruction still merges that slot's candidate dictionary and verifies the complete original context hash. Unknown, unused, conflicting or missing dictionary references fail closed.

One factoring and expansion implementation serves both explicit versions. Existing `shared-json-v2` requests and the default remain unchanged for historical evidence and paired comparison. The candidate prompt explains dictionary lookup without expanding slot permissions. Its first integration is the bounded real-runtime admission harness; this decision does not promote a gameplay Composition or claim a model success-rate improvement.

The earlier benchmark-only `shared-json-catalog-order-v1` codec additionally indexes every handle through an integer dictionary. This candidate removes that extra lookup and integrates direct handle sequences with the real coordinator. Historical requests and the earlier failed format trial remain intact. Repeating the general sharing idea is not itself new evidence; a separate prospective comparison is required.

## Pros and Cons of the Options

### Retain inline orders

- Requires no extra lookup in the prompt.
- Repeats the same sequence for every matching slot.

### Remove order or merge reference scope

- Produces smaller input.
- Changes the context or permitted references and violates the lossless comparison contract.

### Share exact sequences

- Removes duplication while retaining full order and slot permissions, verified by round-trip hashes.
- Adds dictionary indirection whose model behavior must be measured prospectively; byte savings alone do not establish token savings or reliable gameplay.

## Links

- [Approved reversible-layout experiment scope](../specs/0029-nonthinking-gameplay-efficiency-experiment.md)
- [Shared context codec](../../src/engine/mechanics/shared-batch-context.ts)
- [Actual runtime admission harness](../../src/engine/benchmarks/step-efficiency/resolution-admission.ts)
- [Historical integer-indexed benchmark codec](../../src/engine/benchmarks/step-efficiency/catalog-order-codec.ts)
