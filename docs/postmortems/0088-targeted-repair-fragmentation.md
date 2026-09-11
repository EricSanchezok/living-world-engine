# Targeted Repair Fragmentation

Artifact-Version: 1

## Executive summary

A full-world non-thinking trial issued 63 observation requests, including 46 requests identified as repair. Physical batching retained a target-specific group key, so ready repairs for different observers could not share a request even when the reversible slot representation preserved every ownership boundary.

## Summary

This defect increased the minimum physical request count for simultaneous targeted repair work. It is not an attribution of all observed observation cost to this key: asynchronous arrival, malformed outputs, private-information rejection and repeated component/global rendering also contributed. The trial achieved a replayable technical commit but failed source review; neither the run nor this scheduling correction establishes playable semantics.

## Timeline

- A complete world trial reached its first technical commit after extensive observation repair.
- The source-bound review vetoed the candidate and prevented a second paid step.
- Ledger metadata and coordinator code identified separate repair targets as a physical grouping boundary.
- A coordinator regression reproduced six simultaneous repair inputs as six physical provider requests.
- The versioned shared-context contract coalesces those inputs while retaining their exact expanded contexts and per-slot output validation.

## Root cause

The batching key reused the logical repair target as a physical isolation requirement. Slot ownership and complete error evidence already lived inside each reversible slot context, but tests covered normal observation batching and generic repair evidence without combining different explicit repair targets.

## Guardrails

The [coordinator regressions](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) compare every reconstructed input, verify one-slot failure isolation, and retain revision, profile and cancellation boundaries. The [slot repair contract](../specs/0070-slot-local-repair-batching.md) requires new paid evidence before claiming end-to-end savings. The [source-review gate](../../src/engine/benchmarks/step-efficiency/trajectory-source-review.ts) remains the experimental semantic veto: component-reviewed observations and later globally regenerated observations do not share a verified semantic identity merely because their observer IDs match. This scheduling change does not repair that separate verification-coverage gap.
