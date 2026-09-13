# Share Global Planning Source Inventories

## Status

Accepted
Class: architecture

## Context and Problem Statement

Global fallback makes every canonical source eligible for every action. Action-local fact copies and the physical worklist then multiply the same evidence. A complete request can exceed its model profile's input ceiling before transport. The required choice set is large, but its repeated representation is unnecessary.

## Decision Drivers

- Preserve every evidence record and every action's source choices.
- Keep the existing model input ceiling and output semantics.
- Distinguish mechanical compression from empirical model accuracy and latency.

## Considered Options

- Increase the profile limit or reduce the global action set.
- Remove repeated evidence copies while leaving their source handles only.
- Share exact evidence records and ordered action inventories in an experimental physical layout.

## Decision Outcome

Use an explicit source pool for global planning experiments. A record dictionary retains all exact source fields, including fact evidence. Ordered inventories retain each action's selectors; worklist positions have a checked ordinal encoding. A source hash verifies exact reconstruction, while original decoders and canonical validators retain authority. The [experiment contract](../specs/0153-global-planning-source-pool.md) owns scope and qualification.

## Pros and Cons of the Options

A larger input ceiling retains duplicated work and can exceed the provider's usable context; reducing global actions changes joint adjudication. Handle-only evidence weakens the explicit source presentation being evaluated. Shared exact records remove repeated bytes while preserving reconstructability, but introduce lookup work for the model and do not avoid earlier construction costs automatically. Empirical source review and complete gameplay remain necessary before runtime promotion.

## Links

- [Source inventory owner](../../src/engine/contracts/resolution-source-inventory.ts)
- [Physical worklist owner](../../src/engine/mechanics/physical-planning-worklist.ts)
- [Existing exact shared context codec](../../src/engine/mechanics/shared-batch-context.ts)
