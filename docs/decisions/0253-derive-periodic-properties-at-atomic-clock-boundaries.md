# Derive periodic properties at atomic clock boundaries

## Status

Accepted
Class: architecture

## Context and Problem Statement

An authored night description remained night after the world clock advanced. Long activities need consistent environmental phases, and separate realms can have different cycles. Asking an adjudicator to remember to update each location makes correctness depend on which actors happen to act there. Giving every actor current astronomical truth would instead violate perceptual isolation.

## Decision Drivers

- Preserve deterministic world state, atomic effects and exact replay.
- Keep elapsed-duration terms separate from recurring physical phases.
- Avoid model calls solely to update a periodic value.
- Preserve prior observations and ordinary perceptual access.

## Considered Options

- Let semantic adjudication update environmental descriptions when needed.
- Represent each transition as a recurring scripted action or timer effect.
- Derive immutable authored periodic properties from the canonical clock.

## Decision Outcome

Derive each property from its period, initial phase and ordered values at import and atomic time advancement. A property owns one canonical fact; normal effects cannot overwrite its identity or subject/predicate slot. Phase transitions participate in the existing boundary scheduler. Settlement samples observations at the actual completion time, while historical observations stay unchanged.

The local adjudicator sees applicable cycle definitions and their next transition, but no global clock dependency invalidates every pending action at each checkpoint. Normal fact dependencies detect relevant phase changes. Location-scoped elapsed units remain a separate authoring contract.

This gives up freely changing a cycle during play. Seasons with changing periods, weather, eclipses, artificial lighting and actors' schedules require their own ordinary causal state and actions; a daylight cycle alone does not establish visibility or trigger a voluntary action.

## Pros and Cons of the Options

- Semantic updates allow arbitrary context, but permit stale unvisited regions and inconsistent replay inputs.
- Recurring timer effects can express unusual events, but require repetitive authored operations and schedule management for a value already determined by time.
- Clock derivation is exact, cheap and auditable, but applies only to fixed periodic definitions and adds a versioned world contract.

## Links

- [Periodic property contract](../specs/0199-authored-periodic-world-properties.md)
- [Long activity and elapsed-unit contract](../specs/0198-long-activity-duration-and-interruption.md)
- [Import, simulation and replay regressions](../../src/engine/direct/__tests__/periodic-properties.test.ts)
