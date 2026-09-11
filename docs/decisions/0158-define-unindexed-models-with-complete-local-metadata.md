# Define Unindexed Models with Complete Local Metadata

## Status

Accepted
Class: architecture

## Context and Problem Statement

An official model release can precede its models.dev entry. Partial local overrides cannot safely establish a missing model's capabilities, while waiting for directory publication prevents use of an explicitly requested available model.

## Decision Drivers

Keep exact identities, trusted local transport, explicit inference compatibility and attributable snapshots. Avoid remote metadata scraping or paid discovery in the runtime, and prevent local definitions from changing automatic model selection.

## Considered Options

- Require directory publication before any new model can be selected.
- Infer missing capabilities from the model name or reuse a retired model's identity.
- Accept complete explicit local definitions for exact selectors.

## Decision Outcome

The registry accepts complete definitions through its existing local metadata override structure under [the local definition contract](../specs/0098-complete-local-model-metadata.md). Locally defined identities are excluded from latest-compatible selection. All fields carry local provenance in the frozen snapshot and pass existing capability checks. The [single remote source and snapshot decision](0076-resolve-models-from-audited-capability-snapshots.md) remains the runtime foundation.

## Pros and Cons of the Options

Waiting retains a simple directory boundary but makes third-party indexing a launch dependency. Name inference or identity reuse hides uncertainty and changes audit meaning. Complete local definitions preserve explicit operator control and replayable evidence; their capabilities must be maintained and independently verified. The engine does not treat metadata as a live availability check.

## Links

- [Complete local definition contract](../specs/0098-complete-local-model-metadata.md)
- [Provider model cohort accounting](../specs/0097-provider-model-cohort-accounting.md)
- [Dynamic registry architecture](0076-resolve-models-from-audited-capability-snapshots.md)
