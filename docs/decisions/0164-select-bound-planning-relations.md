# Select Bound Planning Relations

## Status

Accepted
Class: architecture

## Context and Problem Statement

Independent reference fields allow existing handles to form invalid combinations: an opposed rating can belong to an entity outside the selected targets, and a meter can belong to a different entity from the effect target. Profile references also share one mechanic namespace although their roles differ. Additional prose rules do not prevent these combinations at the representation boundary.

## Decision Drivers

Preserve every legal model choice and open action semantics; make mechanical relationships explicit; retain independent slot validation and source-bound repair; avoid guessing the intended entity or effect.

## Considered Options

1. Continue selecting independent references and recover through validation.
2. Select complete, source-bound relations with a reversible codec.
3. Replace mismatched references automatically using nearby prose or a selected meter's owner.

## Decision Outcome

Use an opt-in codec that derives complete relation menus from visible state and slot permissions. Actor choices are local to the assigned action. Opposed ratings and meter/profile choices depend on an explicit position in the plan's selected targets. Condition/duration choices retain authored pairs and open conditions. The decoder restores exact choices; the original full validator and semantic review still run. This trades additional input menus and codec work for fewer independently generated relationship fields; prospective measurement determines adoption.

## Pros and Cons of the Options

Independent references minimize adaptation but leave the model to reproduce deterministic relationships across a large context. Bound choices preserve legal expressiveness and prevent specific inconsistent combinations, but add input and do not prove semantic correctness. Automatic correction is concise but chooses meaning on the model's behalf, so it is rejected.

## Links

- [Behavior contract](../specs/0114-bind-planning-relation-choices.md)
- [Existing perception relation codec](../../src/engine/mechanics/perception-rating-choices.ts)
- [Local repair reconstruction](0163-reconstruct-joint-plans-after-local-repair.md)
