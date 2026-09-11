# Index existing plan causes

## Status

Accepted
Class: feature

## Context and Problem Statement

Full-context planning repeatedly emitted entity references as plan causes. A valid target or means source is not necessarily legal causal evidence. The planner currently chooses both a reference and its discriminator even though the catalog already binds them. An obsolete prompt list also names post-plan evidence excluded by the canonical plan schema.

## Decision Drivers

Reduce representational failures without changing action meaning, omitting evidence, weakening causal validation or increasing calls.

## Considered Options

- Keep free kind/ref output with prompt reminders alone.
- Repair illegal output by guessing another cause or dropping it.
- Offer a reversible index over every existing legal catalog cause.

## Decision Outcome

Use an opt-in indexed cause domain for the existing indexed planner. The model selects evidence; the codec only restores its exact bound kind/ref. Slot authority and canonical validation remain mandatory. Correct the obsolete prompt vocabulary to match the canonical schema.

## Pros and Cons of the Options

Reminders preserve the existing format but leave redundant discriminator selection exposed to error. Guessing or dropping a cause changes the model's evidence and is rejected. Indexed selection removes that redundancy and preserves every legal catalog option, at the cost of an additional source projection and changed model-visible layout. Model and gameplay outcomes require fresh evidence; invalid or unsupported choices can still fail.

## Links

- [Source-indexed cause contract](../specs/0086-source-indexed-plan-causes.md)
- [Natural SQL: Making SQL Easier to Infer from Natural Language Specifications](https://aclanthology.org/2021.findings-emnlp.174/) — motivation for simpler intermediate output followed by deterministic reconstruction; this does not establish effectiveness for game planning.
