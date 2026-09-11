# Balance complete planning components

## Status

Accepted
Class: architecture

## Context and Problem Statement

A physical planning slot owns an entire conflict component. Component counts therefore hide differences in assigned-action work. A single large planning response can dominate latency even when all independent components are ready. Reducing the slot ceiling alone can still group the largest components together.

## Decision Drivers

- Preserve joint adjudication inside each conflict component.
- Shorten the planning critical path without reducing world activity or enabling thinking.
- Keep the extra request and duplicated-context cost measurable and opt-in.

## Considered Options

- Retain maximum coalescing by component count.
- Lower the slot ceiling or split individual actions out of components.
- Partition complete components by estimated action work into two concurrent groups.

## Decision Outcome

Expose `balanced-two-v1` in the shared-state-first batching configuration for initial component planning. Within each existing compatible ready group, larger components go first to the least-loaded group, with deterministic subject ordering and the original slot ceiling. This borrows the LPT scheduling rule, using assigned-action count only as a work estimate. Repairs and other stages retain their existing batching rules. The transport owns physical grouping; it does not alter logical sources, adjudication or commit ownership.

## Pros and Cons of the Options

Maximum coalescing minimizes duplicated context but concentrates output generation. A smaller slot ceiling ignores component size, while splitting a conflict component changes joint adjudication. Work balancing retains complete components and offers independent output generation at the cost of more HTTP requests and duplicated input. Hosted-model execution lacks LPT's known processing times and identical-machine assumptions, so its latency benefit requires fresh measurement. Two groups are a bounded experimental choice, not a general optimum or a default promotion.

## Links

- [Behavior and validation contract](../specs/0117-balance-initial-planning-work.md)
- [Coordinator](../../src/engine/mechanics/truth-batch-provider.ts)
- [Longest Processing Time rule for identical parallel machines revisited](https://arxiv.org/abs/1801.05489)
