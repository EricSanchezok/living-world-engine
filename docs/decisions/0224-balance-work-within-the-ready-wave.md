# Balance work within the ready wave

## Status

Accepted
Class: architecture

## Context and Problem Statement

A slot ceiling counts logical conflict components rather than actions. Dispatching as soon as that ceiling fills prevents the coordinator from balancing other components already runnable in the same promise wave. Whole-component work can therefore concentrate in one physical request while another request contains little work.

## Decision Drivers

Preserve joint adjudication, unchanged logical sources and random commitments; reduce output concentration; keep the slot ceiling and minimum request count; avoid time windows and waiting for unfinished dependencies.

## Considered Options

1. Dispatch each full prefix immediately.
2. Split each ready prefix into at least two physical requests.
3. Collect the existing ready wave and balance whole components across the minimum required requests.

## Decision Outcome

The opt-in `ready-wave-work-v1` policy uses option 3 under [Spec 0178](../specs/0178-balance-ready-planning-waves.md). It combines the existing post-promise boundary with capacity-constrained descending-work assignment. The incremental player diagnostic pins this policy; the standard Composition retains its existing configuration. Other stages use fixed partitions and the same ready-wave dispatch boundary.

## Pros and Cons of the Options

1. Starts a full prefix immediately but can hide already-ready work from scheduling. Physical batching by slot count does not balance output work.
2. Exposes more concurrency but increases calls and repeated shared context. The [two-group experiment](0168-balance-complete-planning-components.md) retains that explicit tradeoff.
3. Keeps the minimum initial request count and preserves each complete logical component. It adds only the existing promise-wave scheduling boundary. Capacity limits and indivisible components can prevent equal loads, and action count is only a proxy for model work. Real latency and output quality require measurement; no classical LPT approximation guarantee is claimed for hosted inference.

## Links

- [Post-promise scheduling](0143-post-promise-batch-dispatch.md)
- [Whole-component work balancing and research provenance](0168-balance-complete-planning-components.md)
- [Truth batching coordinator](../../src/engine/mechanics/truth-batch-provider.ts)
