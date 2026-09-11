# Isolate Perception Context From Output Protocol

## Status
Accepted
Class: architecture

## Context and Problem Statement

The assessment experiment combines an observer/action/spatial index with a different output and evidence protocol. Its full-scene failures do not establish whether that index helps the canonical perception directive. Independent actor and Rating references still fail in a complete player scene despite explicit ownership instructions.

## Decision Drivers

- Reuse the existing exact source projection without duplicating its implementation.
- Preserve open check meaning and all source evidence.
- Separate a layout hypothesis from output-contract changes and actual decoding guarantees.

## Considered Options

- Promote the combined assessment or Rating-choice experiments.
- Add another output representation with stronger dependent choices.
- Test the existing work-item index as an optional canonical-request postlude.

## Decision Outcome

The benchmark-only postlude isolates the input representation while preserving canonical output and validation. Its source binding covers complete canonical truth as well as actions and assignments. The default runtime does not enable it. The [probe contract](../specs/0125-perception-task-context-probe.md) owns empirical acceptance.

## Pros and Cons of the Options

Promoting the combined experiments ignores their recorded failures. A new output representation introduces additional variables before the current source-usage hypothesis is tested. The postlude reuses existing source data and keeps the output protocol stable, but increases input volume and may repeat the earlier layout failure. It provides no constrained decoding, visibility decision or semantic guarantee.

## Links

- [Lost in the Middle](https://arxiv.org/abs/2307.03172) motivates controlled position experiments in document question answering and key-value retrieval; its results do not establish causality or improvement for this game's model and workload.
- [Owner-bound Rating choices](0161-select-perception-ratings-with-their-owners.md).
