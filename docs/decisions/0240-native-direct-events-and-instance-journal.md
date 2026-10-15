# Native Direct events and instance journal

## Status
Accepted
Class: architecture

## Context and Problem Statement

Direct has a local action and event contract, while the shared execution interface requires reference-resolution structures. Constructing these structures applies the entire event before the canonical owner repeats that application. Historical events also contain repeated control snapshots, and every instance update serializes the entire history, including narration-only updates.

## Decision Drivers

- Keep the canonical validator authoritative and replay deterministic.
- Make the selected algorithm's actual protocol explicit.
- Preserve full evidence without copying old evidence on every write.
- Maintain one forward-only representation for each runtime and saved contract.

## Considered Options

- Retain the common reference-shaped envelope and optimize copying within it.
- Let each algorithm mutate canonical state directly.
- Use native Direct events, a single canonical application and shared immutable JSON blocks.

## Decision Outcome

Choose native Direct events under [Spec 0186](../specs/0186-native-direct-commits-and-instance-journal.md). Direct and the research reference algorithm have distinct protocol types. Direct candidates contain the frozen event; only the canonical owner applies it. Historical control changes are lossless and hash-bound. Current state, immutable history, narration and Ledger payloads share content-addressed JSON blocks; the instance root and terminal execution change in the same SQLite transaction. A single codec also deduplicates repeated snapshots inside Ledger artifacts, which instance-only relational normalization would leave untouched.

## Pros and Cons of the Options

- A reference-shaped envelope preserves existing consumers but keeps empty structures, misleading stages and duplicate materialization.
- Algorithm-owned mutation shortens the call chain but removes the independent commit authority.
- Native events and shared blocks remove these costs while preserving the authority boundary. They require direct consumer updates and a new save contract; historical data remains in its archived data root. Hashing still traverses logical values, and immutable blocks retain historical evidence instead of automatically collecting it.

## Links

- [System architecture](../architecture.md)
- [Direct runtime](../game-design/direct-runtime.md)
- [Runtime observability](../game-design/runtime-observability.md)
