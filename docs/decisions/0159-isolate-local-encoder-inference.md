# Isolate Local Encoder Inference from the Host Event Loop

## Status
Accepted
Class: architecture

## Context and Problem Statement

The local feature extractor returns promises, but ONNX Runtime Node performs native inference synchronously inside a `setImmediate` callback. Running it on the world host thread can prevent independent transport, token-counter pipes, cancellation, and timers from progressing. Promise scheduling alone does not isolate CPU work.

## Decision Drivers

- Keep the world host responsive during native inference.
- Preserve model assets, precision, tokenization, pooling, batch cardinality, vector order, and cache identity.
- Reuse one loaded model and propagate native failures to every affected request.
- Support the native dependency resolver used by both CLI and Next.js server entry points.

## Considered Options

- Retain in-thread inference with longer timeouts or more event-loop yields.
- Run a persistent worker thread for each loaded encoder runtime.
- Run a separate encoder process with an IPC service.

## Decision Outcome

A persistent worker owns feature extraction and an ordered request queue. The host retains asset verification and cache ownership. Worker messages preserve the existing embedding results and inference options. Idle workers do not keep the host alive; active requests do. Disposal drains preceding requests and releases the worker. Unexpected worker exit rejects pending and future requests without silently restarting inference.

The worker bootstrap is a literal program with an absolute dependency URL supplied by the existing native resolver. It requires neither TypeScript hooks nor a runtime path to a bundled application source file. This avoids placing the native inference dependency behind Next.js module rewriting.

## Pros and Cons of the Options

- In-thread execution is simplest, but longer deadlines and yields cannot make an individual native inference call nonblocking.
- A persistent worker isolates event-loop scheduling while sharing the installed runtime and avoiding model reload per query. It adds message lifecycle management and does not isolate a fatal native process crash or eliminate CPU contention.
- A separate process offers stronger native crash isolation, but adds process supervision, a deployment entry point, and IPC lifecycle complexity that the observed scheduling failure does not require.

## Links

- [ONNX Runtime Node 1.24.3 backend](https://github.com/microsoft/onnxruntime/blob/v1.24.3/js/node/lib/backend.ts) — native run wrapped in `setImmediate`.
- [Node.js worker threads](https://nodejs.org/api/worker_threads.html) — CPU execution on independent JavaScript threads.
- [Embedding cache and enrollment](0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md).
- [Encoder worker regression tests](../../src/engine/algorithms/eager-reference/candidate-retrieval/encoder-worker.test.ts).
