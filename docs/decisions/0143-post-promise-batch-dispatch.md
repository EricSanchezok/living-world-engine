# Post-promise batch dispatch

## Status

Accepted
Class: architecture

## Context and Problem Statement

Independent world components close random commitments in deterministic order. The resulting promise continuations can become ready successively within one event-loop turn. Flushing on the first following microtask separates compatible transitions into singleton model calls, repeating their complete world context.

## Decision Drivers

Preserve deterministic commitments, full context and ready-work progress while collecting compatible continuations without an arbitrary latency window or a global synchronization barrier.

## Considered Options

- Flush at the next microtask.
- Add a timer window or wait for all components.
- Flush after the current promise jobs using Node nextTick scheduled from a microtask.

## Decision Outcome

The explicit post-promise-v1 candidate uses a microtask to schedule nextTick for an underfilled flush. It adopts DataLoader's post-promise scheduling idea through the repository's existing coordinator, without copying its loader, caching or source implementation. Node's scheduling APIs keep this server-only. The complete-batch threshold and every grouping and validation boundary remain authoritative.

## Pros and Cons of the Options

Next-microtask dispatch minimizes local scheduling delay but fragments ordered promise continuations. Timers introduce arbitrary waiting, while a global barrier can hold ready work behind slow or failed components. Post-promise dispatch collects the current ready chain without either delay mechanism; it depends on Node event-loop semantics and still cannot combine work that becomes ready in later external-I/O turns. Larger physical batches change model behavior and need fresh validation.

## Links

- [Change contract](../specs/0079-post-promise-truth-batching.md)
- [DataLoader scheduling implementation](https://github.com/graphql/dataloader/blob/main/src/index.js)
- [Node microtask and nextTick semantics](https://nodejs.org/api/process.html#when-to-use-queuemicrotask-vs-processnexttick)
- [Coordinator](../../src/engine/mechanics/truth-batch-provider.ts)
