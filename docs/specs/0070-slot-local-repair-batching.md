# Slot-local Repair Batching

Artifact-Version: 1
Status: Approved

## Intent

Remove target-identity fragmentation from the existing independent-slot scheduler under the [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). Different repair targets are different logical tasks, not automatically different physical requests.

## Contract

The versioned physical request contract can coalesce ready targeted repairs only when complete contexts are represented by the reversible shared-context codec. Every slot retains its exact target, errors, previous output when present, reference catalog, source state, action assignment and validation path. Normal requests and targeted repairs remain separate. Existing model, prompt, schema, revision, execution, cancellation and slot-count boundaries remain enforced. Output errors remain local to the affected slot; accepted neighbors are not regenerated.

No timer waits for additional tasks, no batch cardinality is reduced, and no new model role or call is introduced. This changes physical grouping and therefore requires fresh evidence before claiming gameplay savings. It does not authorize reuse of component observations as merged-world observations, nor certify narrative semantics. The existing source review can still veto any commit. Closed runs and their budget remain immutable.

## Plan

Reproduce different-target fragmentation at the real coordinator boundary, preserve complete expanded inputs and isolated failure delivery, update the request contract identity, and run check:fast before the local commit. No paid gameplay trial is part of this unit.

## Verification

Concurrent targeted observation repairs with different targets must form a bounded physical batch and reconstruct exactly their original logical contexts. Malformed output for one slot must reject only that slot. Different source revisions, model profiles, cancellation signals and normal-versus-repair requests must remain separated.

## Evidence

[Coordinator tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) own grouping, reversible evidence and isolated output-delivery checks. [The incident report](../postmortems/0088-targeted-repair-fragmentation.md) describes the observed failure and the remaining semantic limitation.
