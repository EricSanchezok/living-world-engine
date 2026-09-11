# Express a resolution magnitude once on the experimental wire

## Status
Superseded by [0120](0120-dependent-resolution-fields.md)
Class: simplification

## Context and Problem Statement

The canonical resolution validator requires `baseEffect` to equal `primaryEffect.magnitude`, or `none` when no primary effect exists. A model can emit conflicting copies and exhaust bounded repair before any world state commits. These copies do not represent independent semantic choices.

## Decision Drivers

- Preserve every valid canonical plan and every independent semantic choice.
- Remove a deterministically redundant output field rather than relax validation.
- Preserve physical batching, raw evidence and isolated experimental selection.

## Considered Options

- Retain both fields and provide more repair instructions.
- Accept inconsistent output and choose one value after validation fails.
- Omit the duplicate field in a candidate wire representation and expand it deterministically.

## Decision Outcome

The candidate `single-magnitude-truth-resolution` uses the primary effect magnitude as the sole wire representation of base magnitude. A physical-request adapter changes only the corresponding schema and effect instruction, then expands output before canonical validation. Canonical state, validators and settlement remain shared with the reference implementation. The encoder refuses contradictory canonical inputs; the decoder refuses an explicitly supplied duplicate field. The candidate preserves existing batching by wrapping the provider beneath the coordinator.

## Pros and Cons of the Options

### Keep both fields

- Preserves the current model contract.
- Requires a model to satisfy a constraint with no additional expressive benefit; precise feedback has not established recovery on the recorded failures.

### Repair inconsistent values automatically

- Can accept some rejected outputs immediately.
- Cannot establish which conflicting magnitude represents the intended action, and would turn output repair into an unapproved semantic choice.

### Represent once and expand

- Is bijective on consistent canonical values and removes one contradiction by construction.
- Needs a pinned experimental codec and adapter evidence; it does not address unrelated reference or factor errors and does not establish gameplay success by itself.

## Links

- [Approved continuation spec](../specs/0027-single-magnitude-resolution-experiment.md)
- [Canonical effect validation](../../src/engine/mechanics/resolution.ts)
- [Resolution plans and deterministic bands](0067-open-semantic-resolution-plans.md)
- STEP-E1 evidence
