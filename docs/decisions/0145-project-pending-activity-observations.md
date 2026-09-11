# Project pending activity observations

## Status

Accepted
Class: feature

## Context and Problem Statement

Observation generation can turn another subject's intent into a claim about the observer, or narrate an unrecorded sub-action as completed. A structured reviewer can still cite a valid but semantically unrelated outcome. Reference membership does not prove entailment. For a narrowly admitted pending interval, actor identity and activity status already exist as typed engine data.

## Decision Drivers

Preserve open actions, avoid invented knowledge, retain strict commits, reduce unnecessary model work, and keep experimental behavior identifiable in the Composition.

## Considered Options

- Require increasingly detailed semantic review of every generated observation.
- Mechanically rewrite arbitrary observation subjects or predicates after generation.
- Directly project a limited progress observation when exact state and lifecycle checks admit it.

## Decision Outcome

Register an opt-in source-bound renderer that uses direct projection only for an unchanged world's active activity before its next boundary. It quotes the owner's full source action as intent and does not generate new apparent claims. Other cases use the existing model renderer. Final candidate review and source-based gameplay acceptance remain necessary.

## Pros and Cons of the Options

More review preserves expressive narration but adds cost and does not establish reliable entailment. Rewriting arbitrary claims can silently alter meaning. Direct projection avoids inventing meaning and saves admitted model work, but produces less varied narration and may omit optional perceptual detail. Conservative state, event, timing and repair guards restrict its scope; this is not a general replacement for perception or Truth Engine adjudication.

## Links

- [Contract and verification](../specs/0082-source-bound-pending-observations.md)
- [Observation coverage diagnostic](../specs/0081-observation-coverage-diagnostic.md)
