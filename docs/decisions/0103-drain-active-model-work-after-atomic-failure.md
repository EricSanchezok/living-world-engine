# Drain Active Model Work After Atomic Failure

## Status

Accepted
Class: architecture

## Context and Problem Statement

Independent components of one atomic world step can have concurrent model pipelines. Once a component exhausts recovery, sibling work cannot produce a committable step. Continuing queued requests and subsequent phases spends money on an invalid attempt; disconnecting every active response can instead erase observable usage while leaving provider charges unknown.

## Decision Drivers

- Preserve the original terminal failure and strict atomic state semantics.
- Stop avoidable future model requests promptly.
- Retain usage evidence for requests already in flight.
- Preserve explicit operator cancellation of active transport.

## Considered Options

- Let every component finish its entire pipeline.
- Abort all component HTTP immediately after terminal failure.
- Cancel pending and new work while draining active HTTP responses.

## Decision Outcome

Cancel pending and new work while draining active HTTP responses. A component cancellation domain propagates a pending-work signal through model scopes. The gateway combines it with operator cancellation only for scheduling and retry waits; active transport retains the original operator signal. The component join waits for active work to settle and reports the first causal error before secondary cancellation errors. No failed attempt commits partial state.

## Pros and Cons of the Options

Letting every pipeline finish preserves usage but spends on work whose result cannot be committed. Aborting all HTTP stops local waiting quickly but does not establish a refund and can create unknown billing. Draining active responses bounds the remaining work by the dispatch window and retains returned usage, at the cost of waiting for those requests or their existing timeouts. Independent operator cancellation can still interrupt them and retains ordinary unknown-billing handling.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Gateway scheduling and usage regression](../../src/engine/models/__tests__/model-provider.test.ts)
- [Atomic component failure regression](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts)
- [Node AbortSignal API](https://nodejs.org/api/globals.html#class-abortsignal)
