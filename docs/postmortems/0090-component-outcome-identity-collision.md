# Component Outcome Identity Collision

Artifact-Version: 1

## Executive summary

A real step regression with two independent components generated the same outcome identity for two different actions. A targeted final review could not select one repair owner.

## Summary

Each response legitimately used its own local outcome proposal key. The materializer treated that local name and ordinal as a global identity seed. The canonical commit checks validated one outcome per action but did not require unique outcome record IDs across components.

## Timeline

- Independent component responses each emitted a first outcome with the same local proposal key.
- Component validation accepted both because each covered its own action exactly once.
- Merging retained both records with an identical global ID.
- A final-candidate regression rejected one outcome and found two possible component owners.

## Root cause

The outcome identity allocator omitted the original action owner. Reference lookup and targeted repair require unique record identity, which is a different invariant from one outcome per action. This is demonstrated by deterministic reproduction, not an attribution of the historical gameplay semantic failure to this collision.

## Guardrails

Outcome IDs bind to the original action, keeping identity stable across repair and independent of local proposal names. Canonical commit rejects duplicate outcome IDs. [Final-candidate tests](../../src/engine/algorithms/eager-reference/__tests__/final-candidate-review.test.ts) generate identical local names in separate components and require unique IDs, one repair owner and unchanged unrelated work. [Specification 0075](../specs/0075-final-step-causal-review.md) owns the final review contract.
