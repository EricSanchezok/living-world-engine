# Truth Rejected Candidate Repair

Artifact-Version: 1
Status: Approved

## Intent

Within the delegated repair-defect scope of [0029](0029-nonthinking-gameplay-efficiency-experiment.md), make logical Truth validation failures repairable against the exact candidate they reject. Keep first requests, source actions, state, permissions, batch cardinality and validation authority unchanged.

## Contract

The bounded semantic loop retains a detached copy of the latest rejected logical value. Post-generation validation uses the value before validation can mutate it; provider failures use their explicit raw logical value. A failure without an available candidate clears earlier evidence. Null is available data. Physical envelope recovery remains the physical coordinator's responsibility and cannot masquerade as a logical candidate.

Only retry requests add candidate evidence. Truth repair binds the candidate to the first logical source-context hash, logical invocation, owning schema, preceding invocation and canonical candidate hash. The candidate is uncommitted model data, never canonical truth or instructions. Error paths refer to its local schema. The complete current task remains authoritative, including required outputs absent from the rejected candidate. The model returns a complete corrected candidate; the engine neither fills effects nor chooses replacement sources. Every result passes the existing complete validators.

Shared context codecs preserve candidate ownership and verify their existing hashes. Unfactored batches retain complete repair evidence beside the owning task slot. Output codecs encode repair examples using the same reversible representation as the response, while binding hashes identify the canonical pre-encoding value. Initial requests have no added field or notice. Retry context records the repair-contract version, bound by the actual request hash; the logical prompt identity remains compatible with audit aggregation.

## Plan

Retain rejected values at the semantic-loop boundary, attach scoped evidence in Truth generation, preserve it through physical batching, and verify full-step and codec paths. Freeze a new bounded historical-response recovery probe before any paid use; preserve all consumed trial identities and costs.

## Verification

Cover validation mutation, malformed provider values, null, missing-candidate resets and independent concurrent loops. Verify first-request equality, exact candidate binding and uncommitted state through a real loaded-world step, then verify local ownership through shared and unfactored batches and selector encoding. Relevant tests and check:fast precede the local commit. Paid recovery and source-semantic acceptance remain separate gates.

## Evidence

[Decision 0127](../decisions/0127-repair-against-rejected-logical-candidates.md) owns representation alternatives. The [semantic-loop tests](../../src/engine/models/__tests__/semantic-repair.test.ts), [full-step tests](../../src/engine/mechanics/__tests__/resolution-plan-inspection.test.ts), and [coordinator tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) own regression evidence.
