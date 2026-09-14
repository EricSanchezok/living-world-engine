# Test explicit compilation access sets

## Status

Accepted
Class: architecture

## Context and Problem Statement

Dependency declarations determine the initial concurrency partition. The model-facing phrase "potentially affected" can encourage broad scene membership even when a location is merely consulted. Broad declarations may be justified, so a deterministic rule deleting location dependencies would change the simulation without an adequate proof.

## Decision Drivers

- Preserve complete source semantics and every legal dependency.
- Distinguish information access from conservative write coverage.
- Measure partition quality without assuming independence.

## Considered Options

1. Test a reversible read/write field representation with clearer existing-role instructions.
2. Delete location or future-target dependencies using heuristics.
3. Introduce independently committed partitions immediately.
4. Keep the current representation without a controlled comparison.

## Decision Outcome

Use option 1 as a benchmark under [spec 0175](../specs/0175-explicit-compilation-access-sets.md). The adapter changes field representation and instructions, not the meaning or membership of decoded access sets. Original materialization and subsequent actual-conflict checks remain mandatory. It is a prerequisite investigation into dependency quality, not an implementation of parallel discrete-event synchronization or a correctness certificate for narrower partitions.

## Pros and Cons of the Options

The model may still declare overbroad writes or omit necessary ones. Retain all negative results and review source support before interpreting graph size. Do not prefer fewer edges over correctness. Options 2 and 3 require stronger causal and temporal evidence; existing ordered random-stream release must remain intact.

## Links

- [Dependency materialization](../../src/engine/mechanics/action-dependency.ts).
- [Ordered random consumption](0105-order-random-consumption-without-resampling-plans.md).
- [Shared-condition creation scopes](0200-cover-condition-creation-with-subject-scopes.md).
