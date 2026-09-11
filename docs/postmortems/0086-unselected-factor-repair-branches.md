# Unselected Factor Repair Branches

Artifact-Version: 1

## Executive summary

A complete-world trial passed compilation but exhausted a component's plan repairs. Missing directions in explicitly chosen control and potency factors produced a long tree of failures for unrelated roles and authorities.

## Summary

The first component repair omitted two directions. The next attempt supplied one direction, removed another factor, and introduced baseEffect:null although a null primary effect requires the derived magnitude none. The final conflict was correctly rejected and the complete step rolled back. Precise feedback cannot by itself establish that the plan preserves the action's meaning.

## Timeline

- An initial component plan omitted its mode.
- Repair selected automatic mode and declared semantic control and potency factors without directions.
- Nested ordinary unions evaluated every role and authority; repair received a large alternative tree instead of the two selected-branch field errors.
- The next response introduced a conflicting dependent magnitude and exhausted repair.
- Offline inspection identified the explicit discriminator literals as sufficient to select validation branches without making any semantic decision for the model.

## Root cause

The schema represented mutually exclusive tagged alternatives as ordinary unions. Failure rendering correctly retained every alternative's errors, but this exposed irrelevant choices despite the candidate already declaring role and authority. Existing tests protected alternative-preserving feedback; they did not distinguish an unselected semantic union from an explicitly tagged one.

## Guardrails

The [discriminant contract](../specs/0069-resolution-factor-discriminants.md) retains the same strict alternatives and legal output domain. [Regression tests](../../src/engine/contracts/__tests__/resolution-factor-discriminants.test.ts) compare the unselected and discriminated schemas, report both missing directions, preserve all source and direction choices, and reject invalid values. No missing direction or dependent magnitude is guessed. Full source review and actual state commits remain required.
