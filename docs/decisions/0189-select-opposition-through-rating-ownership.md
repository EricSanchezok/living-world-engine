# Select Opposition Through Rating Ownership

## Status
Accepted
Class: testing

## Context and Problem Statement

An existing rating can be paired with an existing opposing entity that does not own it. Both references are structurally valid while the original check derivation rejects the pair. Hierarchical relation menus cover this dependency but require a target-list position and a second rating position, add substantial context and affect several other effect domains.

## Decision Drivers

- Keep the intended opponent an explicit generation choice.
- Preserve all originally legal combinations and downstream semantic review.
- Separate this one dependency from effect/profile and actor-rating representations.
- Retain historical failures and measure actual output use and cost.

## Considered Options

- Retain two independent references with ownership reminders.
- Select target and rating positions from hierarchical menus.
- Select one existing rating and explicitly reference its displayed owner.
- Correct a mismatched target or rating after generation.

## Decision Outcome

Use the independently configured experiment in [0136](../specs/0136-rating-owned-opposition.md). Explicit targetRef null selects the owner of the selected rating record. A compact flat projection displays this relation with its source-slot permissions. Existing explicit targets are preserved without correction. The materializer still rejects undeclared plan targets and all other invalid mechanical relationships.

## Pros and Cons of the Options

### Independent references

Retains the vocabulary but asks the model to reproduce the ownership relation across fields.

### Hierarchical menus

Expresses legal combinations but retains two positional choices and the overhead of unrelated domains when applied together.

### Rating-owned opposition

Makes the selected rating's existing owner authoritative for the explicit null form. It requires a clear generation convention and can still select a semantically wrong opponent; neither valid references nor shorter output proves correct gameplay.

### Post-generation correction

Can hide a failed choice by substituting a different opponent or aptitude. It changes supplied semantics and is excluded.

## Links

- [NatSQL](https://aclanthology.org/2021.findings-emnlp.174/) motivates expressing generated intermediate representations with fewer redundant structural choices; its SQL inference rules and performance are not transferred to this experiment.
- [Bound planning relations](0164-select-bound-planning-relations.md).
- [Original check derivation](../../src/engine/mechanics/resolution.ts).
