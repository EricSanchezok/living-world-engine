# Source outcome prose from events

## Status

Accepted
Class: feature

## Context and Problem Statement

An outcome can claim that a letter was sent while the candidate contains no corresponding event or state change. Downstream observation rendering can then repeat that claim. Rewriting an entire component for a failed assertion also changes unrelated summaries. Free outcome prose duplicates a semantic channel outside the world event record.

## Decision Drivers

Retain open-world expression, make realized occurrences traceable, avoid more critics, preserve bounded repair and keep experimental changes in the pinned Composition.

## Considered Options

- Keep independent outcome prose and increase semantic review requirements.
- Rewrite suspicious verbs or subjects after generation.
- Generate realized occurrences through existing event/state channels and derive outcome prose from those records.

## Decision Outcome

Use the third option in an explicit experimental contract. Outcome status remains a model decision. Its prose repeats only that status and same-slot events directly caused by its source action. The engine does not infer new events or fix narrative meaning. Full candidate events remain available for observation and causal verification even when their causes are indirect.

## Pros and Cons of the Options

More review retains expressive summaries but increases costs and can still miss source mismatches. Verb rewriting is language dependent and can silently change meaning. Event-sourced prose removes one opportunity to invent an occurrence and avoids rewriting an independent summary during repair. It requires the model to record meaningful occurrences explicitly, may increase event tokens, and does not establish that a generated event is correct. These risks require actual state and temporal validation, not a format-only success claim.

## Links

- [Contract](../specs/0083-event-sourced-outcome-summaries.md)
- [Pending observation projection](../specs/0082-source-bound-pending-observations.md)
- [Coverage diagnostic](../specs/0081-observation-coverage-diagnostic.md)
