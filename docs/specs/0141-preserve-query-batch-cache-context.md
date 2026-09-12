# Preserve query batch cache context

Artifact-Version: 1
Status: Approved

## Intent

Preserve an uncached physical query batch's retrieval result when preceding requests change cache contents. This experiment follows the delegated [player action efficiency work](0122-player-action-efficiency.md) and its complete-source requirement. It addresses query memoization with the current encoder; it does not certify passage-cache generation or change production defaults.

## Contract

The candidate memoizes the complete ordered list of unique query strings supplied to the existing encoder. Prefixing, deduplication order, model graph, tokenizer, batching, all vector values and downstream ranking remain unchanged. An identical batch may reuse its complete immutable result, including concurrent work. A partially overlapping or reordered batch encodes its complete original unique list; it cannot combine independently produced vectors. Bound retained memory by vector count, evict complete least-recently-used batches, and reject malformed vectors without caching them.

The reference per-query cache remains the experimental control. Neither the new cache nor a new encoder enters the default Composition through this work. Persistent passage vectors are held fixed and read-only in the comparison; their separate dependence on original encoding batches remains unresolved. The candidate does not claim per-query vector invariance across arbitrary batches or change the complete natural-language inputs to obtain it.

The offline diagnostic retains full recorded requests from the original 49-action cohort and tests all five physical batches, including the observed overlap between two world contexts. First verify each cold source against its recorded shortlist and model-context hashes. Compare the reference partial cache and candidate against the same cold result, then verify complete warm reuse with no additional encoding. Preserve mismatches, vector deltas, all query strings, cache counts and timings. No provider HTTP, new model output, world commit, semantic success or player-latency claim is permitted from this evidence alone.

## Plan

1. Reproduce cache-dependent selection with the actual local encoder and frozen passage vectors.
2. Implement complete-batch memoization as an isolated candidate with bounded retention and concurrency tests.
3. Compare full recorded physical batches and record the correctness and local-compute tradeoff before considering integration.

## Verification

Use a batch-dependent encoder fixture to prove that partial scalar reuse changes results and complete-batch memoization preserves uncached behavior. Cover changed ordering, duplicate strings, complete warm and in-flight reuse, vector-budget eviction, oversized batches and invalid-result recovery. Run the actual R5 retrieval diagnostic with native assets and no network. Run focused checks and `npm run check:fast` before the local commit.

## Evidence

The [cache candidate tests](../../src/engine/benchmarks/step-efficiency/complete-query-batch-cache.test.ts) own deterministic memoization checks. The [recorded-source diagnostic](../../scripts/experiments/verify-query-batch-cache.ts) owns native retrieval comparison. [The decision](../decisions/0193-memoize-complete-query-encoder-batches.md) records alternatives and limitations.
