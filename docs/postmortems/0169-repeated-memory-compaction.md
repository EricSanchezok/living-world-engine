# Repeated memory compaction under inflated pressure

Artifact-Version: 1

## Executive summary

A twelve-turn memory qualification made eleven compaction calls. Recall and replay passed, but the acceptance criterion rewarded repeated compaction without evaluating whether those calls were useful. Conservative token estimates, duplicated request sections and occupancy-only admission compounded the problem.

## Summary

The preserved qualification instance is `7b3c3515-e2ae-4a39-96ca-1a908b21714e`. Invocation `d7c665f4-81c9-4830-9957-48c0ed356a58::rt:model-audit:9255f9abd7f34a7514cfc428402322c93e3160a16a0c805f8d50c8329feb3047` spans Ledger sequences 373–389: preflight estimated 53,413 tokens while provider usage was 29,343. Invocation `fd8f6760-e091-44d6-bd61-1ab0f83f5c2c::rt:model-audit:043c894f005f17d40d0f875db08e4a7dcaf5a580aebdf993888382f3d3e51413` spans 1824–1849: preflight estimated 59,621 and actual usage was 34,475. These are aggregate input counts, not exact per-question counts.

The final request repeated a 1,063-character policy across 29 questions and repeated eleven spoken exchanges in two arrays. The first compaction covered twenty source records, the second four, and the following nine only two each. All eleven calls together consumed 30,756 input and 6,321 output tokens.

## Timeline

1. Initial long-term-memory qualification completed twelve real-model turns with eleven successful compactions, intact recall and successful replay. Its acceptance check required repeated compaction but did not evaluate admission efficiency.
2. The user questioned the frequency and the persistent 83–93% reported pressure. Inspection of retained request and usage evidence separated estimation error, repeated context and small eligible prefixes.
3. The fix calibrated existing returned usage, shared repeated request content and batched useful new history. Two intermediate twelve-turn runs exposed a remaining uncalibrated per-question floor and cross-family calibration; the final run completed twelve turns with two compactions, intact old/new recall and successful replay.

## Root cause

The calibration stored a monotonic maximum starting at one, so overestimation could never decrease. The complete-context limit correctly included rules and questions, but memory scheduling treated all pressure as a reason to summarize any newly eligible record. Repeated conversational projections inflated pressure further. The real-play harness required three compactions instead of measuring necessary work separately from preservation quality.

## Guardrails

- [Calibration regressions](../../src/engine/models/__tests__/context-budget.test.ts) check bidirectional learning, dispatch-ordered samples, independent families and capacity guards.
- [Decision transport regressions](../../src/engine/models/__tests__/decision-v2.test.ts) check one shared policy with all questions and candidates retained.
- [Direct regressions](../../src/engine/direct/__tests__/runtime.test.ts) check the single private interaction timeline, current evidence, causal references and cognitive isolation.
- [Discourse regressions](../../src/server/__tests__/world-discourse.test.ts) check that player interpretation reads the authoritative published exchanges without a duplicate conversation array.
- [Memory host regressions](../../src/server/__tests__/agent-memory.test.ts) check batching across restart, hard-capacity recovery and protected records across successive publications.
- [Real-play qualification](../../scripts/operations/memory-playtest.ts) separates twelve fixed participant actions, recall and replay from compaction frequency, actual usage and total calls.
