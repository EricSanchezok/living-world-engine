# Native Encoder Inference Starved Context Admission

Artifact-Version: 1

## Executive summary

A full-world diagnostic stopped before action-compilation HTTP dispatch while local token counters waited for host I/O. The compiler model had not returned invalid output. Native candidate-encoder inference occupied the host thread despite an asynchronous JavaScript API.

## Summary

The isolated experiment preserved the failed revision and billing evidence. Standalone token counting completed in about 0.21 seconds; concurrent counting with an already loaded, idle encoder also passed. A real WorldHost reproduction with network replaced at the transport boundary delayed counters by 7–37 seconds. Native sampling placed the main thread inside ONNX inference. Ledger method instrumentation did not reproduce the suspected multi-second audit-write stall.

These measurements diagnose one local scheduling failure, not whole-game latency or semantic correctness. A CPU-profiler attempt terminated without a usable profile; the usable evidence came from a separate reproduction with native sampling and explicit method timings.

## Timeline

- A full-world run completed bootstrap and stopped with local context-admission failures before compiler HTTP dispatch.
- Standalone and concurrent token-counter checks passed, including checks after loading and using the encoder.
- Ledger-only reproduction completed quickly; isolated WorldHost reproduction exposed main-thread native inference while token counters were pending.
- The native dependency source confirmed that its promise wrapper schedules synchronous inference through `setImmediate`.
- Feature extraction moved to a persistent worker with unchanged assets, inference options, and cache fingerprints.

## Root cause

The host overlapped candidate retrieval with model work, assuming that awaiting the local feature extractor allowed other I/O to progress. ONNX Runtime's asynchronous interface deferred synchronous native execution to an event-loop callback. While that callback ran, the host could not drain child-process pipes or service transport and timer callbacks. Extending the counter deadline would hide the scheduling problem and preserve the gameplay stall.

The earlier counter regression exercised concurrency before or after native inference, not during it. Small synthetic providers also completed without blocking, so tests did not cover the real concurrency boundary.

## Guardrails

- [Encoder worker tests](../../src/engine/algorithms/eager-reference/candidate-retrieval/encoder-worker.test.ts) run a real worker with a synchronous inference fixture that requires a host release. They also cover preserved inference options, ordered results, per-request rejection, worker exit, and disposal.
- [Worker isolation decision](../decisions/0159-isolate-local-encoder-inference.md) defines the execution boundary and remaining native-crash limitation.
- [Candidate cache tests](../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache.test.ts) retain the cache consistency boundary independently of scheduling.
