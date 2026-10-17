# Actor-scoped quantity inspection

## Status

Accepted
Class: architecture

## Context and Problem Statement

An inventory can exist in canonical quantities while a successful inspection reveals only its holder's appearance. Copying the number into an authored fact creates two owners for the same changing resource. Revealing all holdings whenever the holder is visible exposes concealed contents and unrelated accounts.

## Decision Drivers

- Preserve the quantity kernel as the only owner of inventory arithmetic.
- Let actual measurement produce usable evidence without granting it to bystanders.
- Retain prepared-action dependencies, settlement, replay and one batched world judgment.

## Considered Options

- Add mutable quantity copies to ordinary world facts.
- Reveal every visible entity's holdings automatically.
- Adjudicate selected-target measurement and project admitted quantities to the inspector.

## Decision Outcome

Use selected-target measurement. The existing world batch selects which quantity identities the concrete inspection can measure. Prepared actions retain those references; mechanical settlement reads current values and the inspecting actor receives the quantity evidence. Witnesses receive no private inspection result without their own channel. Explicit visible zero rows can be reported; missing rows are not measured zeros. The direct producer is version 6 and its control state is version 3; old prepared saves are rejected rather than adapted.

## Pros and Cons of the Options

Fact copies fit the existing perception path but drift from transfers and production. Automatic visibility is cheap but confuses seeing a holder with knowing all its contents. Selected measurement preserves one quantity owner and cognitive isolation, at the cost of one bounded decision slot per quantity on the inspected target. It adds no separate model call.

## Links

- [Approved behavior](../specs/0197-quantity-inspection-and-final-action-state.md)
- [Runtime implementation](../../src/engine/direct/world.ts)
- [Simulation-entry regressions](../../src/engine/direct/__tests__/runtime.test.ts)
- [Actual sample failures](../../worlds/fanren/authoring/validation/followup-live-runs.json)
