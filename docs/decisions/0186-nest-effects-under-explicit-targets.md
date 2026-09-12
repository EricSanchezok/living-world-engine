# Nest Effects Under Explicit Targets

## Status
Accepted
Class: testing

## Context and Problem Statement

Planning uses action-local means positions, global entity indices and plan-local effect positions. A model can omit the selected target list or choose valid indices whose meanings belong to another domain. Canonical reference validity alone cannot detect an effect assigned to the wrong existing subject. Located repair feedback does not establish first-response reliability.

## Decision Drivers

- Make effect ownership explicit in the generated structure.
- Preserve every original entity choice, effect and arbitrary action meaning.
- Retain exact decoding, source scope and independently valid slots.
- Measure complete generation cost and semantic errors before adoption.

## Considered Options

- Retain the positional relationship and add repair reminders.
- Emit independent entity references in the target list and each effect.
- Nest effect roles under explicitly named target records.
- Infer missing targets from effect descriptions or remove orphan effects.

## Decision Outcome

Select the separately configured experiment in [0133](../specs/0133-target-owned-planning-effects.md). A target record explicitly chooses an existing entity and owns its effect bodies. Structural nesting replaces the model's positional join; the decoder supplies no semantic choice. Original validators and source review remain authoritative.

## Pros and Cons of the Options

### Positional relationship with reminders

- Keeps the compact transport vocabulary.
- Retains the failed dependency and adds recovery cost without first-response evidence.

### Independent references

- Makes each subject readable without interpreting an index.
- Still permits an effect subject absent from the declared target list and repeats reference spelling.

### Target-owned effects

- Expresses membership by containment and keeps additional or repeated targets explicit.
- Adds target records and can still choose a semantically wrong entity; empirical cost and source fidelity remain uncertain.

### Inferred targets or removed effects

- Can make malformed output appear valid.
- Changes action meaning without an explicit model choice and conceals failure.

## Links

- [NatSQL](https://aclanthology.org/2021.findings-emnlp.174/) motivates aligning a generated intermediate representation with the expressed task. Its SQL-specific inference rules and reported gains are not adopted or claimed for this experiment.
- [Indexed planning](0134-index-planning-record-references.md).
- [Repair-field mapping](0185-map-indexed-repair-fields.md).
