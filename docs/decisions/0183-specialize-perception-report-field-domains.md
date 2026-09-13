# Specialize Perception Report Field Domains

## Status
Accepted
Class: feature

## Context and Problem Statement

A reference can exist in the global catalog and still be illegal in one output field. Reference kind alone also cannot establish that a local entity and a canonical entity denote the same object. Global reminders and schema acceptance do not prove these distinctions.

## Decision Drivers

- Present all legal symbols at the field where the model selects them.
- Preserve arbitrary source semantics, complete context and canonical validation.
- Distinguish identity from ownership and part/whole relations without banning discovery.
- Measure added request cost and actual source fidelity independently.

## Considered Options

- Keep generic kind patterns and append another global reminder.
- Accept additional evidence kinds or infer an intended identity after generation.
- Specialize field domains from the complete catalog and state identity denotation locally.

## Decision Outcome

Use the isolated benchmark transformation defined by [0130](../specs/0130-perception-report-field-domains.md). Exact domains expose existing materializer permissions, assigned observer/action joins and committed-check outcomes without selecting a semantic answer. Per-target schema branches carry matching check identities, stakes and fixed outcomes and compile the same provenance and coverage constraints as canonical validation. Identity denotation remains model-owned and independently reviewed. The generation schema is an instruction to the hosted model; the original schema and materializer still own acceptance. No production algorithm selects the adapter implicitly.

## Pros and Cons of the Options

### Global reminders

- Preserve a smaller generic schema.
- Leave the model to reconcile broad catalog permissions with narrower fields and can repeat ineffective instructions.

### Broaden or infer acceptance

- Can suppress particular rejections.
- Changes evidence authority or invents the intended identity, rather than addressing selection under the existing contract.

### Complete field domains

- Move exact applicable symbols beside their selection fields while retaining every legal option and ordinary failure evidence.
- Add schema bytes and do not guarantee correct prose, observer ownership or natural-language identity.

## Links

- [Experiment contract](../specs/0130-perception-report-field-domains.md)
- [Onset receipt contract](../specs/0128-observer-bound-onset-receipts.md)
- [PICARD](https://aclanthology.org/2021.emnlp-main.779/), schema-informed incremental decoding; hosted generation here supplies no token-logit control.
