# Calibrated pressure and compaction batching

## Status
Accepted
Class: simplification

## Context and Problem Statement

An incremental memory can remain over a request-level threshold because of fixed rules, duplicated presentation or recent records that cannot yet be compacted. Triggering another summary whenever any new record exists spends inference without addressing that pressure. A conservative estimate that only rises cannot learn that its tokenizer approximation is too expensive.

## Decision Drivers

Preserve the 80% threshold and important records, use existing returned usage, amortize summary work, keep all decision questions, and avoid a retrieval system or extra inference.

## Considered Options

- Trigger on occupancy alone and require a fixed resulting compression ratio.
- Impose a turn-count cooldown or use an additional token-count request.
- Calibrate from existing responses, share redundant context and batch eligible new history.

## Decision Outcome

Use returned input usage to calibrate a conservative estimator by account/model metadata, schema family, Agent/world decision view and language band. Three samples permit downward correction; the maximum of the last 32 dispatch-ordered ratios retains 10% headroom and raises immediately. The learned tokenizer factor applies to the full batch and to shared state plus the largest question, with independent limits. Aggregate usage calibrates an approximation; it does not identify an exact per-question count. Native byte checks use the actual shared-policy transport representation.

Share common native decision policy once in state, retaining every independent task and candidate. One private interaction timeline owns spoken exchanges; active and unanswered interactions reference its IDs. Original evidence retains its validation meaning.

At 80%, new eligible history must reach the larger of 2,048 heuristic tokens or the existing summary plus protected-record representation before background compaction. These quantities use the same uncalibrated units: the rule amortizes rewriting memory, not the whole request or a target output ratio. Already protected records are excluded from disposable new history. At capacity, eligible work can bypass batching and the existing version-fenced rebuild applies. Failure without room remains explicit.

## Pros and Cons of the Options

Occupancy alone confuses non-memory cost with compressible history; a fixed output ratio encourages losing detail. Turn cooldowns depend on arbitrary turn length and can defer a sudden large observation. A token-count endpoint adds latency and calls. Returned-usage calibration and content batching reuse existing boundaries and reduce avoidable work, at the cost of a conservative cold start and approximate per-question counts. No estimate guarantees provider tokenization; actual provider capacity errors remain authoritative.

## Links

- [Incremental memory](0245-incremental-agent-memory.md)
- [Efficiency contract](../specs/0193-memory-pressure-efficiency.md)
- [Token estimation and calibration](../../src/engine/models/context-budget.ts)
- [Background admission](../../src/server/agent-memory.ts)
