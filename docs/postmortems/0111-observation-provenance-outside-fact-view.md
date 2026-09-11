# Observation provenance outside the fact view

Artifact-Version: 1

## Executive summary

A real player run reached final observation preparation and rolled back before an observation model request. Current events cited existing private facts that the observer's reference resolver had removed. Reference closure over the supplied events repairs the mismatch while retaining fact access and output disclosure checks.

## Summary

The failed run produced no committed world feedback. Parsed transition evidence contained existing private fact causes, while every observer's scoped truth omitted inaccessible facts. The renderer attempted to project the complete event cause list through that narrowed catalog and raised reference.projection_missing. Repeated semantic repair could not change deterministic context construction.

## Timeline

- The observation projection retained authorized state and omitted historical events.
- Reference narrowing derived additional cause identities from the empty projected historical-event list.
- Final observation still supplied the current proposal's complete events.
- A full player trial reached this combination with private fact causes.
- Loaded-world regression cases reproduced the same exception before model dispatch, including a case intended to test disclosure repair.

## Root cause

The catalog and event projection consumed different event sets. Fact visibility was incorrectly reused as the eligibility condition for an event's causal identity. Existing tests exercised private facts without event causes and events without private fact causes, leaving their interaction uncovered.

## Guardrails

[The provenance contract](../specs/0110-preserve-observation-event-provenance.md) distinguishes reference closure from fact access. [Renderer tests](../../src/engine/cognition/__tests__/observation-renderer.test.ts) exercise owner and non-owner views, unchanged cause lists, unrelated hidden candidates, missing sources and hidden-content rejection followed by repair. These checks establish deterministic construction and boundary behavior; prospective full-player testing remains necessary for gameplay acceptance.
