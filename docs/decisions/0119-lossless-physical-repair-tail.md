# Lossless physical repair tail

## Status
Accepted
Class: feature

## Context and Problem Statement

Physical structural repairs insert a new instruction before the task and a large feedback object into the canonical context. They invalidate the original request prefix even though its state, assignments and schema remain unchanged. Repeated cache-miss input can dominate the cost of an unsuccessful step.

## Decision Drivers

- Retain every original action, constraint, rejected draft and validation issue.
- Preserve existing slot delivery, bounded repair and atomicity rules.
- Measure provider cache behavior without adding model calls.
- Bind layout changes to explicit Composition and audit identities.

## Considered Options

- Keep feedback before the original task and mixed into its context.
- Move the complete physical repair instruction and feedback after the original request.
- Omit the rejected draft or replace it with a summary.

## Decision Outcome

Shared Truth batching supports the opt-in `repairPlacement: tail-v1` configuration. On a physical structural repair, the JSON-object transport renders the unchanged initial task, context, schema and example policy first, then the exact repair instruction and complete `batchRepair` object. It changes no feedback value and performs no semantic or syntax correction. The original full context remains in the audit; the rendering policy enters request and contract hashes. Prompt size accounting includes the tail. Missing or mismatched physical feedback fails before a request is sent, and other transport modes reject this policy.

This policy does not apply to logical semantic repair, whose task or schema may legitimately change. A newly split batch establishes its own initial request; no cache identity is inferred across changed source states or assignments. The default configuration remains unchanged. Real cache hit rates and whole-step effects require bounded experiments under the [full-step efficiency spec](../specs/0026-full-step-efficiency-experiment.md).

Representation adapters can append task instructions after batching. The formatter identifies exactly one complete physical repair paragraph, preserves all surrounding task bytes, and relocates only that paragraph with its bound feedback. A missing, duplicated or partial paragraph remains an error; final position inside the unrendered task is not an ownership requirement.

## Pros and Cons of the Options

Keeping the existing layout requires no policy but changes the prefix on every repair. Complete feedback at the tail preserves a reusable prefix and all evidence, but its position may affect model behavior and provider caching remains best effort. Omitting or summarizing a draft can reduce tokens but changes the supplied information and is a separate intervention; it is not part of this lossless policy.

## Links

- [Truth repair boundaries](0079-truth-engine-output-repair-boundaries.md)
- [Exact logical contexts](0104-factor-exact-logical-contexts-for-truth-batches.md)
- [DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)
