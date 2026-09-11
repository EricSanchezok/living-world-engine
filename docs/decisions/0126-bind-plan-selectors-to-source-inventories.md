# Bind Plan Selectors to Source Inventories

## Status

Accepted
Class: architecture

## Context and Problem Statement

Plan output can contain invented entity handles or a real source belonging to a different action's grounding. Enumerating entity references alone leaves means ownership implicit. The existing source inventory already identifies every legal kind/ref pair for each action, so mechanical reference construction can be separated from the model's evidence selection.

## Decision Drivers

- Preserve source meaning, every legal selection and full physical batches.
- Bind means choices to the action they support.
- Keep repair mappings stable and reject invented values explicitly.
- Measure representation overhead and actual first-call behavior before promotion.

## Considered Options

1. Annotate existing source inventories with exact stable selectors and decode field-scoped selections.
2. Add complete handle enumerations to each output schema.
3. Select a source automatically from the action's prose or a nearest reference.

## Decision Outcome

The opt-in adapter uses stable content-derived selectors, validated for collisions in each request. Means selector identity includes its owning action. Lookup always uses the current slot's complete source inventory. Short stable identities survive batch reordering without sharing selection authority between actions. Context annotations preserve the original source and bind through the shared codec; output expansion owns only targets and means.source. [Spec 0036](../specs/0036-plan-source-selectors.md) defines evaluation and promotion boundaries.

## Pros and Cons of the Options

1. Explicit selection removes kind/ref assembly and represents action ownership without choosing evidence for the model. It adds inventory annotations and another tested representation boundary; invalid selections still require repair.
2. Full enumerations keep canonical output but duplicate long references and cannot express action-specific scope with the existing common plan schema without substantial schema growth.
3. Automatic selection can convert an invalid response into a different intended action and obscures the distinction between mechanical validity and semantic correctness.

## Links

- [Resolution source inventory](../../src/engine/contracts/resolution-source-inventory.ts).
- [Visible target vocabulary experiment](0125-enumerate-visible-plan-targets-after-batching.md).
- [Dependent-field representation](../../src/engine/mechanics/resolution-dependent-fields-codec.ts).
