# Memoize complete query encoder batches

## Status

Accepted
Class: architecture

## Context and Problem Statement

The configured encoder graph contains dynamic quantization. An individual query vector can depend on other tensor entries and padding in its native batch. A cache keyed only by query text reuses that vector in another batch and removes hits from the newly encoded batch. Both reused and newly encoded vectors can therefore differ from an uncached request, changing the candidate selection seen by the compiler.

## Decision Drivers

- Preserve the existing complete cold-batch result without choosing new references.
- Retain useful exact-repeat and concurrent reuse.
- Measure additional local computation separately from model success and player latency.
- Avoid an implicit encoder, passage-cache or production-algorithm replacement.

## Considered Options

1. Memoize complete ordered unique query batches in an isolated candidate.
2. Retain independent text caching and assume embeddings are batch invariant.
3. Switch the complete query and passage pipeline to a separately qualified full-precision encoder.
4. Encode every query individually or change the quantization graph.

## Decision Outcome

Select option 1 for the bounded offline comparison. A complete ordered batch is the memoized function input; partial overlap never substitutes cached items into another invocation. The [experiment contract](../specs/0141-preserve-query-batch-cache-context.md) owns memory, validation and source requirements. Existing production selection and persistent passage caches remain outside the candidate's activation scope.

## Pros and Cons of the Options

1. Preserves current uncached vectors and needs no new model graph or passage generation. It gives up partial-hit savings and does not solve the encoder's intrinsic batch dependence or certify existing passage caches.
2. Maximizes apparent hits, but cache history changes the meaning of the encoded batch and the selected evidence.
3. Can address the underlying graph dependence across both caches. It requires distinct assets, fingerprints, complete passage regeneration, timing and retrieval-quality qualification; the [earlier encoder experiment](../specs/0025-action-compilation-semantic-first-pass-experiment.md) is not a promoted compiler integration.
4. Can isolate each query or quantization domain, but changes uncached embeddings, native dispatch behavior and cost. It requires a separately measured inference contract rather than a cache-only correction.

## Links

- [ONNX DynamicQuantizeLinear](https://onnx.ai/onnx/operators/onnx__DynamicQuantizeLinear.html) defines scalar per-tensor scale and zero point.
- [Current encoder](../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts).
- [Candidate implementation](../../src/engine/benchmarks/step-efficiency/complete-query-batch-cache.ts).
