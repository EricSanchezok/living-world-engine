# Ordered promises fragmented transition batches

Artifact-Version: 1

## Executive summary

Canonical transitions supported the shared-context batch representation but still reached the model as individual requests. The underfilled-batch microtask ran between ordered commitment continuations. An explicit post-promise scheduling boundary collects the ready continuation chain while retaining the existing slot ceiling and grouping rules.

## Summary

A real full-world trajectory stopped during response-body transport after 55 HTTP requests without committing its first step. Among known responses, 22 canonical transition requests consumed about 46 percent of the partial conservative estimate. They shared execution and role boundaries but repeated the complete world context in single-request envelopes. The socket closure is a separate unresolved network event; scheduling changes cannot prove that it will not recur.

## Timeline

- Random commitments were released before transition generation so independent model work could proceed concurrently.
- The existing coordinator retained next-microtask flushing and synchronous-burst tests.
- A real trajectory exposed individual canonical requests despite a twelve-slot configuration.
- A regression through OrderedRandomStream reproduced two singles; post-promise scheduling produced one batch with identical logical contexts and outcomes.

## Root cause

Concurrency at the provider queue does not imply coalescence at the earlier batch collector. Ordered promise releases can enqueue a transition, its flush, and the next component's continuation in separate microtask positions. The first flush drains a singleton before the next compatible request arrives. Tests issued concurrent requests synchronously and did not reproduce the actual asynchronous commitment boundary. Inspecting registered batch configuration alone therefore missed the loss of physical batching.

## Guardrails

[The ordered transition regression](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) covers the real commitment primitive. [Registered game-step comparison](../../scripts/operations/step-truth-flush.test.ts) verifies configuration reachability and final effects. [Coordinator boundaries](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) retain cancellation, revision/profile isolation, partial progress and the slot ceiling. [The recorded-source preflight](../../scripts/experiments/step-canonical-scheduling-preflight.ts) verifies exact baseline HTTP bodies and complete input restoration before any fresh model evidence is claimed. [Decision 0143](../decisions/0143-post-promise-batch-dispatch.md) documents the scheduling mechanism and its limits.
