# Calibrated memory pressure and useful compaction

Artifact-Version: 1
Status: Implemented

## Intent

The user authorizes correcting token estimates, redundant request content and repeated compaction admission together. Preserve the 80% trigger, important original records, concurrent append safety and the existing gateway/reader. Do not add model calls, retrieval, a fixed compression target or compatibility implementations.

## Contract

- Estimate the actual transport representation. Learn from returned input usage, allowing conservative estimates to decrease as well as increase. Separate model, request family and language composition; retain headroom and handle out-of-order responses. Aggregate usage does not establish exact individual-question usage. Byte and per-question guards remain independent.
- Send common decision rules once per batch. Keep every question, candidate and semantic constraint. Use one chronological interaction view, with references for the active exchange and unanswered speech. Preserve provenance, recipient distinctions and cognitive isolation; do not deduplicate merely similar facts or discard original memory.
- At 80%, admit compaction only when the eligible new prefix is substantial enough to amortize rewriting the summary. Recent and protected records are not disposable headroom. A full request may bypass the background batching threshold, wait for useful work and rebuild; it must fail explicitly if it still cannot fit. No timer, turn quota or target output ratio drives generation.
- Keep the same instance format and memory reader. Pin the changed Direct producer and wire layout. Existing immutable execution evidence remains available for inspection.

## Plan

Correct gateway sizing/calibration, share decision policy and interaction context, and gate compaction on useful new history. Exercise the real gateway and host, then repeat the same twelve-turn scenario and record actual usage, calls, compactions and recall.

## Verification

Cover downward/upward calibration, concurrent reports, unknown request families, independent capacity guards, shared policy without question loss, private conversation references, batching across restart, hard-capacity recovery and important memory across consecutive compactions. Run focused tests and check:fast. Real play must compare total model calls and actual input tokens as well as recall, without making a minimum compaction count a success criterion.

## Evidence

[Gateway regressions](../../src/engine/models/__tests__/context-budget.test.ts), [Direct regressions](../../src/engine/direct/__tests__/runtime.test.ts), [discourse regressions](../../src/server/__tests__/world-discourse.test.ts) and [memory-host regressions](../../src/server/__tests__/agent-memory.test.ts) cover calibration without added dispatches, shared request fields, private causal references, batching across restart, hard-capacity rebuilding and concurrent append preservation. The full repository fast gate covers the remaining execution paths.

The same twelve-turn scenario at production capacities used 86 physical model calls and 1,672,736 input tokens before the change, versus 80 calls and 1,584,872 input tokens afterward. Compactions fell from eleven to two. All eight final recall checks passed, including the original rescue, debt, deadline and code, plus the later scarf and separate code. World replay and recorded execution replay passed. The final corresponding NPC request changed from 59,621 estimated / 34,475 actual tokens to 31,431 estimated / 28,495 actual tokens. Provider aggregate usage is not an exact per-question measurement.

The final qualification instance is `41210214-32ad-49af-b03a-4ba45fd3ec2b`. Final NPC invocation `2f072d5a-f3a0-4147-a0b7-2d66d88853b4::rt:model-audit:043c894f005f17d40d0f875db08e4a7dcaf5a580aebdf993888382f3d3e51413` supplies the calibrated comparison. All dispatched calls, including existing repair paths, are counted; replay dispatches are excluded. A narrative validation rejection recovered through the existing retry path and is retained in the Ledger. These runs establish this scenario's result, not an unlimited-memory or universal token-accuracy guarantee.
