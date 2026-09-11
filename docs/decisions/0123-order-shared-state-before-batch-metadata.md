# Order shared state before batch metadata

## Status
Accepted
Class: feature

## Context and Problem Statement

A targeted repair preserves valid slots and therefore changes the remaining batch. Catalog hashes near the beginning of canonical JSON can vary before a large identical payload. Less total context can consequently produce more billed cache misses.

## Decision Drivers

- Preserve complete source data and per-slot reference semantics.
- Reuse stable prefixes without asking a model to perform extra work.
- Keep observed provider caching distinct from offline byte similarity.

## Considered Options

- Keep canonical object order for every request.
- Pin and resend the original root envelope on every subset repair.
- Move existing shared state before changing batch metadata.

## Decision Outcome

Implement the opt-in ordering defined by [0032](../specs/0032-shared-state-prefix-layout-experiment.md). Move only existing object members; compare the parsed result with the complete canonical source hash and keep the policy in rendering identity. This changes no logical context paths, scope or generation setting. Keep ordinary singleton rendering unchanged, so batch-to-singleton cache reuse remains an explicit limitation. Admission to a live experiment still requires frozen measured evidence.

## Pros and Cons of the Options

Canonical order is simple and remains the default, but early metadata can invalidate an otherwise useful prefix. Pinning the full root could preserve more bytes across subsets but resends redundant slot information and requires an additional persistent scope binding. Member ordering preserves all existing scope machinery and byte count, at the cost of another explicitly selected rendering policy and incomplete cache reuse when shared values or envelope shape change.

## Links

- [Shared context codec](../../src/engine/mechanics/shared-batch-context.ts)
- [Context rendering and tests](../../src/engine/prompts/context-layout.test.ts)
- [Non-thinking gameplay experiment](../specs/0029-nonthinking-gameplay-efficiency-experiment.md)
