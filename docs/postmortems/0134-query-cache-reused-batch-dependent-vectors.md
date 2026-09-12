# Query cache reused batch-dependent vectors

Artifact-Version: 1

## Executive summary

An offline reconstruction of a complete player compilation batch selected different candidate references when another world context had populated the query cache. The text-keyed cache assumed independently reusable vectors, while the native encoder processes dynamically quantized batches. Reusing some entries also changes the inputs used to encode the remaining misses.

## Summary

The source is execution 14c18986-48ed-40ce-9bc8-0f3caf542273, captured before its first world commit. The second physical compilation source contains twelve of the original forty-nine actions. Replaying it cold preserves its recorded shortlist. Priming with the same source in the finite-work world yields thirty-six query hits and twenty-four misses; all sixty vectors differ from the cold batch, with maximum absolute difference about 0.02665 and fifteen candidate replacements in slot zero. Repeating the complete uncached batch produces identical vectors. This is local retrieval evidence, not proof that a specific model rejection was caused by an omitted candidate.

## Timeline

- The finite-work comparison's initial preflight failed its exact baseline request check after cross-arm cache reuse.
- Independent cold query caches restored all five historical source requests and allowed the comparison to preserve its baseline.
- An initial diagnostic primed the preceding B source; it had no shared query strings and did not reproduce the issue.
- Reconstructing the actual same-source C-to-B order reproduced the original thirty-six hits, twenty-four misses and exact changed shortlist.
- The isolated complete-batch cache candidate is defined by [Spec 0141](../specs/0141-preserve-query-batch-cache-context.md); production activation and passage-cache qualification remain separate.

## Root cause

Memoization keys described individual texts, but the executed function accepted a tensor batch. The configured graph contains forty-eight DynamicQuantizeLinear and seventy-two MatMulInteger nodes. ONNX defines scalar per-tensor quantization ranges; the installed feature-extraction pipeline also chooses padding from the batch. These mechanisms make per-text invariance an assumption that requires evidence. The recorded comparison proves cache-history dependence without separately estimating quantization and padding contributions.

The cache tests used independent vector fixtures, so partial-hit correctness was assumed by the substitute. The earlier full-precision experiment had a separate graph and cache-invariance check but had not been integrated into the current compiler. Holding caches cold made experimental comparisons reproducible without fixing the production memoization assumption.

The same source also exposes a separate inference-contract discrepancy: all sixty query texts exceed the fingerprint's declared 128-token limit, eighteen exceed 512, and the installed pipeline tokenizes the physical batch to sixty by 512 while ignoring the supplied max_length option. Switching to the earlier explicit-128 full-precision path would additionally truncate these query representations. This observation concerns dense query encoding, not deletion of the compiler's original action text or the lexical retrieval channel. Complete-text coverage and accurate inference identity require independent qualification; this cache candidate preserves the current tokenization.

## Guardrails

The [complete-batch candidate tests](../../src/engine/benchmarks/step-efficiency/complete-query-batch-cache.test.ts) use a batch-dependent encoder and exercise exact input preservation, concurrency, validation and bounded retention. The [native comparison](../../scripts/experiments/verify-query-batch-cache.ts) requires every original physical batch, frozen read-only passage vectors and recorded cold selection hashes. These checks do not certify persistent passage generation, arbitrary new batch invariance, model semantics or complete player performance. [The cache decision](../decisions/0193-memoize-complete-query-encoder-batches.md) records the lost partial-hit savings and alternative encoder changes.
