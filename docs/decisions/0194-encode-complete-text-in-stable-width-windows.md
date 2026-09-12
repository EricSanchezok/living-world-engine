# Encode complete text in stable width windows

## Status

Accepted
Class: architecture

## Context and Problem Statement

The dense encoder's dynamic quantization changes a text's vector when its co-batch changes. Fixed padding alone does not eliminate the observed effect. A native FP32 control preserves exact vectors across tested batch partitions at fixed width, while changing width introduces small numerical differences. The complete original player query cohort also contains inputs beyond the model's 512-token limit. Correct complete-batch memoization preserves current cold results but retains truncation and gives up partial-hit savings.

## Decision Drivers

- Include every original payload token in model inference.
- Make per-text input shape independent of other queries and cache history.
- Measure full-precision and complete-input cost rather than assume a speedup.
- Preserve separate identities and qualification for a changed dense representation.

## Considered Options

1. Full-precision non-overlapping windows with per-window stable width buckets and payload-weighted pooling.
2. Complete-batch memoization of the current quantized encoder.
3. Enable the existing explicit 128-token full-precision encoder.
4. Encode each text independently using the quantized model.
5. Replace the embedding model with a longer-context model.

## Decision Outcome

Select the first option as an isolated native experiment under [Spec 0142](../specs/0142-complete-text-window-encoding.md). Complete token coverage and stable cache reuse are acceptance properties; semantic retrieval quality and player speed are unproven. The model and tokenizer remain pinned, but windowing, padding and pooling define a new inference identity. Production defaults and persistent passage caches do not change.

## Pros and Cons of the Options

1. Covers long input and supports batching without letting co-batch length choose padding. It adds model work for tails, removes attention across window boundaries and may dilute short clauses. Full precision has a memory and computation cost.
2. Preserves current cold retrieval exactly and is already a controlled candidate. It retains truncation and recomputes partially overlapping batches.
3. Has earlier native invariance evidence but truncates every query in the current cohort further; it does not satisfy complete-input coverage.
4. Makes the executed quantization domain text-owned, but sacrifices native batching and still requires an explicit long-input design. It remains a possible independently measured alternative.
5. May represent cross-window relationships better, but changes trained weights, language behavior and passage space together; no qualified local asset or comparison currently supports that replacement.

## Links

- [Multilingual E5 model card](https://huggingface.co/intfloat/multilingual-e5-base): prefix, pooling and length contracts.
- [Multilingual E5 technical report](https://arxiv.org/abs/2402.05672): model family provenance, not evidence for this window aggregation.
- [OpenAI long-input embedding example](https://github.com/openai/openai-cookbook/blob/main/examples/Embedding_long_inputs.ipynb): token chunking and length-weighted aggregation; no transfer of its model performance is claimed.
- [Complete-batch cache alternative](0193-memoize-complete-query-encoder-batches.md).
