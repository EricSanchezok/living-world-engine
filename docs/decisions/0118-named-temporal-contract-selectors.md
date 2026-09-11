# Named temporal contract selectors

## Status
Accepted
Class: feature

## Context and Problem Statement

An opaque temporal profile selector hides whether the model is scheduling completion, progress review, conditional continuation, or indefinite activity. A formally valid profile can impose the wrong temporal meaning even when the Activity retains the exact source text. Schema annotations alone do not make that distinction part of the generated selector.

## Decision Drivers

- Preserve every authored profile and all original action semantics.
- Express the temporal commitment at its output decision point.
- Avoid additional reasoning calls, inferred conditions, or automatic profile substitution.
- Keep baseline and candidate behavior independently pinned and measurable.

## Considered Options

- Add more prose around the opaque profile selector.
- Introduce one named selector for each existing temporal contract kind.
- Remove short-duration or conditional profiles from the candidate's choices.

## Decision Outcome

The represented compiler offers the opt-in `temporalContractSelection: named-operators-v1` Composition setting. The output `profileRef` contains one contract-specific selector whose value is the same request-local profile key. Its schema binds that selector to the profile's script-owned kind. The large assertion schema is shared across kinds with the same conditional representation. The codec reversibly restores the canonical scalar before the existing compiler validates and materializes it. Conditions, quantities, identity, candidates and source text are preserved. Repair retains the physical root's dictionary and re-encodes prior output through the same representation.

A contradictory kind/key pair, duplicate selector, or untagged output cannot be silently normalized into a valid canonical plan. This is an experimental representation, not semantic proof or default promotion. Actual model performance requires the source-bound tests and trajectory admission in the [full-step efficiency spec](../specs/0026-full-step-efficiency-experiment.md).

## Pros and Cons of the Options

Additional prose preserves a compact output but leaves the emitted decision opaque. Named selectors expose the temporal commitment in generated tokens while retaining the same expressive choices; they increase schema and output length and can still be selected incorrectly. Removing profiles prevents some errors but also removes legitimate brief and conditional actions, so it is rejected.

## Links

- [Source-owned Activity descriptions](0117-source-owned-activity-descriptions.md)
- [NatSQL](https://aclanthology.org/2021.findings-emnlp.174/) motivates reversible intermediate representations; SQL results do not establish open-world semantic correctness.
- [Schema key wording as an instruction channel](https://arxiv.org/abs/2604.14862) motivates testing wording at the generated decision point. Its mathematical reasoning and constrained-decoding setting does not establish efficacy for this hosted JSON compiler.
