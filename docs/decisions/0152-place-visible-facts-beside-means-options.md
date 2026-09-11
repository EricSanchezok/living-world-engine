# Place visible facts beside means options

## Status

Accepted
Class: feature

## Context and Problem Statement

A diagnostic explicitly selected a population fact to support a price description although the correct offer fact was already eligible. Integer positions eliminated one transcription burden but did not establish relevance. The inventory exposed references while exact typed facts remained elsewhere in the full context.

## Decision Drivers

Preserve model-owned semantics, unchanged source eligibility and complete context; reduce source lookup burden without assuming the intended answer.

## Considered Options

- Automatically replace a suspicious source with an inferred better one.
- Add another model call to choose sources.
- Place exact already-visible facts next to existing source options.

## Decision Outcome

Use the optional local evidence layout in [spec 0089](../specs/0089-action-local-fact-evidence.md). Keep the output and all acceptance gates unchanged. The model must choose and justify its actual source.

## Pros and Cons of the Options

Automatic substitution changes model meaning without evidence. Another model call adds runtime cost and a new failure boundary. Local evidence preserves the information and execution contract but duplicates input and may not improve grounding. Measure that overhead and test complete source batches before drawing a benefit conclusion.

## Evidence Boundaries

This is a source-layout hypothesis motivated by a concrete mismatch, not proof that distance caused the model error or that every means source must be a fact. Exact projection establishes provenance only; it does not prove semantic use of that provenance.

## Links

- [Action-local fact evidence contract](../specs/0089-action-local-fact-evidence.md)
- [Action-local means positions](0150-use-action-local-means-positions.md)
