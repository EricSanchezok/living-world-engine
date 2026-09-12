# Continuing actions discarded interval receipts

Artifact-Version: 1

## Executive summary

A controlled three-second external-player Activity committed a distinct check at each one-second boundary, but health stayed at 12 through the first two boundaries and changed to 10 only at the third. All three steps replayed. The first two receipts were marked unsettled with no operations and were never consumed later.

## Summary

The engine must preserve consequences that occur while a task is still in progress. Delaying or discarding them changes the state available to subsequent decisions and makes committed checks misleading. The reproduced failure affected interval receipt effects; supported direct placement and events already followed a separate causal-validation path.

## Timeline

- Full-player investigation identified a one-second first boundary with many longer continuing Activities.
- Reading the actual TruthEngine showed current-interval planning and check commitment followed by receipt deferral based on whole-task outcome.
- A zero-HTTP run through the real loader, SimulationEngine and committer reproduced three checks and only one applied receipt.
- The receipt and Activity responsibilities were separated under the interval settlement contract.

## Root cause

The transition's continuing status overwrote receipt settlement after a check had already been committed. Transaction verification repeated this coupling, so canonical replay confirmed the lost-effects behavior. The next boundary created a new plan and check rather than consuming the historical receipt. The ordinary plan-review context also omitted the temporal boundary when optional detailed temporal evidence was disabled; canonical world time alone could not identify the adjudicated interval. Existing partial-effect coverage exercised direct placement and events, but asserted that receipts remained unapplied; it did not exercise a required intermediate receipt effect.

The controlled law explicitly required a fresh uncertainty each second. This proves lost interval effects, not that every repeated check in a real world is redundant. No performance saving can be inferred from the fixture.

## Guardrails

[The interval contract](../specs/0134-settle-interval-resolution-effects.md) separates whole-task status from exact-once receipt consumption. The [real-entry receipt regression](../../src/engine/algorithms/eager-reference/__tests__/interval-receipts.test.ts) checks intermediate health, active lifetime, failed-check consequences, atomic rejection and replay. Existing temporal and causal tests retain premature-completion and unsupported-effect rejection. Live source review remains necessary before claiming full-player semantic qualification.
