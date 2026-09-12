# Materialize action-local reference uses

## Status

Accepted
Class: architecture

## Context and Problem Statement

Action Compilation exposes exact actor and target bindings and a shared typed catalog. Selecting a target as an audience can require locating its Entity, finding the separately listed Agent whose details bind it, and retaining that relation across a physical batch. A valid choice can still name another action's participant. Global field domains and typed names address legality without placing this specific relationship beside the decision.

## Decision Drivers

- Preserve the full batch, all legal selections and original semantic authority.
- Make an existing relationship directly available at the action that uses it.
- Avoid name matching, guessed identity repair and extra model calls.
- Isolate an additive input change from output-layout or schema changes.

## Considered Options

1. Materialize exact per-action Entity/Agent field-use pairs as an additive experimental input view.
2. Repeat global field-domain or typed-prefix guidance.
3. Flatten the dependency output and introduce field-local reference indices.
4. Convert invalid Agent choices to their linked Entity after generation.

## Decision Outcome

The experiment selects the additive input view. It joins only declared catalog Entity links and existing actor bindings, retains every visible matching Agent and observes each slot's scope. The original catalog remains available for actions beyond the named targets; a listed relation does not make its record relevant or mandatory. Output choices, validation and materialization remain unchanged. [Spec 0139](../specs/0139-materialize-action-local-reference-uses.md) owns the prospective evidence and admission boundary; production defaults do not select the adapter.

## Pros and Cons of the Options

1. The view removes a repeated lookup while retaining an exact inverse to the source context. It adds input tokens and may still be ignored or semantically misapplied; neither successful construction nor a valid response establishes improvement.
2. Global domains and typed names explain legal uses but leave per-action relationship reconstruction to the model. Their independent [field-domain](0173-share-compilation-field-use-domains.md) and [typed-name](0174-type-compilation-alias-names.md) experiments remain distinct evidence.
3. A flat output can reduce nesting errors and local indices can encode type domains. They change representation and decoder responsibilities, so they are separate interventions rather than an explanation for this input-view result.
4. Post-generation conversion hides the invalid field choice, can be ambiguous, and substitutes intent. Exact input relationships do not authorize such output repair.

## Links

- [Source actor and target bindings](../../src/engine/algorithms/eager-reference/action-compiler.ts).
- [Original field-use contracts](../../src/engine/algorithms/eager-reference/action-compilation-validation.ts).
- [RAT-SQL: Relation-Aware Schema Encoding and Linking for Text-to-SQL Parsers](https://aclanthology.org/2020.acl-main.677/). The analogy is query-conditioned representation of declared relations; its learned attention mechanism and benchmark results are not claims about this adapter.
