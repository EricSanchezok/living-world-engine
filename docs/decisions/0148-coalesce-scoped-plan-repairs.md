# Coalesce scoped plan repairs

## Status

Accepted
Class: feature

## Context and Problem Statement

Semantic plan verification can request independent repairs concurrently. Their single-action scope is necessary for ownership, but excluding their schema name from physical batching repeats the same complete world for every repair. Concurrency alone does not share those inputs.

## Decision Drivers

Reduce avoidable HTTP and context repetition while preserving full semantic review, precise repair ownership, recovery limits and source context.

## Considered Options

- Keep each scoped repair in a separate HTTP request.
- Remove repair or relax the review that requested it.
- Admit scoped repairs to the existing reversible shared batch collector under explicit configuration.

## Decision Outcome

Use the existing collector for an opt-in scoped repair group. The shared commit_plans wire represents the same logical result; the original caller owns validation and replacement. Preserve separate grouping for initial planning and all existing identity and cancellation boundaries. No global repair barrier waits for unavailable work.

## Pros and Cons of the Options

Individual calls are simple but duplicate large contexts. Weakening repair removes semantic protection and does not address transport waste. Shared batching retains each complete request and reuses established delivery machinery; it changes model-visible grouping and therefore requires fresh measured semantic and gameplay evidence. Batches can still fail and incur normal recovery.

## Links

- [Scoped repair contract](../specs/0085-scoped-plan-repair-batching.md)
- [Post-promise scheduling](0143-post-promise-batch-dispatch.md)
