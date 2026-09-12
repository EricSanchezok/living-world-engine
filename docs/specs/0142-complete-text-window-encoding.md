# Complete text window encoding

Artifact-Version: 1
Status: Approved

## Intent

Evaluate complete dense query encoding with a cacheable per-text inference contract under the [player action efficiency objective](0122-player-action-efficiency.md). The [query cache incident](../postmortems/0134-query-cache-reused-batch-dependent-vectors.md) exposes both batch-dependent vectors and incomplete long-text encoding. This is an isolated native encoder experiment, not default retrieval activation.

## Contract

Tokenize each complete prefixed text without truncation. Verify the pinned tokenizer's boundary and query/passage prefix tokens. Partition only payload tokens into consecutive non-overlapping windows that fit the 512-token model limit after adding the same prefix and boundary tokens. Concatenating payload windows must reproduce every original payload token in order. Empty payloads receive one valid prefix-only window. Preserve original strings and token coverage as evidence; token coverage alone does not prove semantic quality.

Use the verified full-precision E5 graph. Each window independently selects the smallest multiple of 32 that fits its complete input, up to 512. Group equal widths for native execution with a ceiling of 128 windows; batch membership cannot choose a window's padding width. Mean-pool valid tokens and normalize each window using the model's standard recipe. Return a single-window vector unchanged. For multiple windows, average their normalized vectors weighted by payload-token count, normalize, and store Float32 values. This is a new representation: chunk boundaries lose cross-window attention and pooling can dilute a short decisive clause.

The experiment identity binds model-directory and graph hashes, tokenizer assets, runtime versions, window/padding/pooling rules and implementation hashes. Do not use the existing fingerprint that declares truncation at 128 tokens. Never combine new vectors with historical passage vectors under the old identity. Passage generation, source-semantic retrieval quality, registered runtime integration and player performance remain separate qualification obligations.

The offline comparison covers all five original batches and all 49 actions. Preserve complete query strings, coverage witnesses, vectors and native timings. Compare cold encoding, actual per-query partial-cache reuse after the recorded alternative-world batch, reordered queries and complete warm reuse. Require exact vector equality for the same candidate text across these cases; retain any failure rather than weakening tolerance. Report encoded windows and padded-token work as well as elapsed time. No provider HTTP, model-output reuse, gameplay mutation or player-latency claim is part of this comparison.

## Plan

1. Separate graph quantization and padding effects with real native controls.
2. Implement and test complete token windows and weighted pooling at the experimental boundary.
3. Run the full recorded query cohort and record correctness, local cost and remaining retrieval obligations.

## Verification

Tests must expose truncation at a boundary, tail omission, duplicate/missing payload tokens, batch-dependent width, output reordering and invalid vectors. Execute the actual native model on recorded complete inputs; independent vector fixtures do not establish native invariance. Run focused tests and `npm run check:fast` before committing.

## Evidence

The [window encoder](../../src/engine/benchmarks/step-efficiency/full-text-window-encoder.ts) owns token coverage and pooling. Its [tests](../../src/engine/benchmarks/step-efficiency/full-text-window-encoder.test.ts) protect those contracts. The [native verifier](../../scripts/experiments/verify-full-text-window-encoder.ts) owns complete-source comparisons. [The decision](../decisions/0194-encode-complete-text-in-stable-width-windows.md) records alternatives and evidence limits.
