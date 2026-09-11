# Specialize the empty resource pool domain

Artifact-Version: 1
Status: Approved

## Intent

Eliminate impossible resource-pool claims before model recovery under the delegated [nonthinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). The source state can establish that no typed shared activity resource pool exists without deciding the meaning of an action.

## Contract

When the immutable compilation source has zero sharedActivityResourcePools, the request schema requires an empty sharedResourceClaims list. It omits unreachable claim-item alternatives. When any pool exists, the existing claim schema and downstream typed, slot, shortlist and quantity validation remain authoritative. This admission condition uses actual source state, not a retrieved shortlist or a narrowed repair batch.

The representation adapter transforms the actual request schema, preserving source-state constraints and physical cardinality through initial and repair calls. It does not reconstruct a more permissive schema. No model output is changed or repaired by this specialization. Original actions, ordinary entity dependencies, audiences, temporal plans, complete context and source evidence remain intact. A ship or another Entity never becomes a pool merely because an action uses it. The engine adds no pool, shortens no action and adds no model call.

## Plan

Bind the known domain to the common compiler request schema and carry that schema through represented output encodings. Version the affected compilation implementations. Freeze a new diagnostic after relevant checks; do not reuse a stopped trial or claim semantic or latency gains from schema validation alone.

## Verification

Exercise the real compiler and each representation with a pool-free state and localized repair: nonempty claims must fail without mutation, correct outputs must preserve compiled plans and dependencies, and the source state must remain unchanged. Use a populated resource world to verify legal pool claims and quantity evidence still materialize. Check that adapter output preserves supplied schema constraints, then run relevant tests and check:fast before a local commit.

## Evidence

[Represented compiler regressions](../../src/engine/algorithms/eager-reference/__tests__/represented-action-compiler.test.ts) cover the common request and encoding boundaries. [Shared resource execution](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) exercises reservation, contention and continued activity. [Postmortem 0112](../postmortems/0112-impossible-claims-in-an-empty-pool-world.md) records the failed source case.
