# Incremental subject-private memory checkpoints

## Status
Accepted
Class: architecture

## Context and Problem Statement

Delivered evidence and beliefs accumulate during sustained play. Sending complete historical records on every decision eventually exceeds the bound model context, while deleting evidence breaks references and replay.

## Decision Drivers

Retain important relationships and events, preserve cognitive isolation, avoid blocking ordinary play, reuse model and persistence infrastructure, and keep one model-input representation.

## Considered Options

- Full historical context until provider rejection.
- Retrieval over historical memories.
- Incremental background summaries with protected records and recent raw evidence.

## Decision Outcome

Use incremental checkpoints. Instance-owned derived memory is separate from semantic world state; the model reader combines its summary, immutable protected records and uncovered evidence. Compression consumes only the owner's frozen source. Hash coverage preserves concurrent appends and changed records, while version fencing prevents competing publications. Complete request pressure starts background work at 80%, without a mandatory output ratio. The original evidence remains the validation and replay authority.

## Pros and Cons of the Options

Full context preserves detail but has unbounded inference cost and eventual rejection. Retrieval permits large archives but adds selection failure and an unwanted subsystem. Checkpoints reuse the existing gateway and Ledger and keep important records in every read, at the cost of lossy ordinary-history summaries and occasional model calls. An ever-growing set of indispensable facts can still exceed finite context; capacity errors remain explicit.

## Links

- [Memory contract](../specs/0192-background-agent-memory.md)
- [Unified perspective](0068-unified-agent-perspective.md)
- [TypeSafe context limits](https://docs.typesafe.ai/models#context-length)
- [DeepSeek model capacities](https://api-docs.deepseek.com/api/list-models/)
