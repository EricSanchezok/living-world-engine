# Compact Planning Records

Artifact-Version: 1
Status: Approved

## Intent

Reduce generated serialization overhead while exposing a plan's mode before its dependent values. The delegated authorization in [0029](0029-nonthinking-gameplay-efficiency-experiment.md) covers this separately configured experiment; the complete gameplay objective remains unchanged.

## Contract

An opt-in indexed planning adapter represents each complete plan as a fixed-column JSON array, with mode and actionIndex first. Its columns are derived from the original mode-specific wire schema. Means, factors and typed source pairs use their own schema-derived columns. Effect records retain named fields. All prose, references, ordering, repeated values, optional-field presence and nonconstant values survive an exact round trip. A trailing object preserves optional plan fields. Only required fields whose original schema allows exactly null can be implicit in the selected mode; no semantic default, source choice, effect, success or permission is inferred.

Exactly repeated schema subtrees use shared local definitions; dereferencing reconstructs the same column constraints. This does not remove predicates, shorten source context or enable a native constraint capability that the provider has not demonstrated.

The schema and current context bind the adapter. Source constraints, full action cardinality, candidate domains, generation parameters, repair ceilings and the existing decoder/materializer/verifier/commit chain remain authoritative. Invalid rows preserve their explicit action identity and rejected row for scoped diagnosis; they never become accepted repaired plans. Missing or ambiguous identity remains a physical batch failure. An unknown mode, incorrect length, mixed representation or changed source is rejected. The adapter does not remove repeated fact assignments or treat mechanically valid plans as semantic proof.

Default compositions remain unchanged. Fresh paired measurement must include every physical HTTP, full token usage, repairs, latency and semantic/commit status. Offline serialized-size savings and deterministic tests do not establish model reliability, gameplay speed or readiness for adoption.

## Plan

Implement a schema-derived record codec at the final indexed planning boundary, preserving the complete upstream prompt and source context. Exercise supported modes, nested record alternatives, optional fields and real physical repair reconstruction. Measure the actual source/body and output sizes before freezing a fresh non-thinking trial.

## Verification

Verify exact encode/decode equality for automatic, check and blocked modes; nullable and optional fields; effect and difficulty source pairs; semantic and authored factor variants; repeated targets and free text. Reject invalid positions, arity, required effects, malformed source roles and snapshot/schema mutation. Exercise the actual indexed TruthEngine pipeline with initial and narrowed repair requests, retaining independent slot outcomes and original semantic review. Run focused checks and the fast gate before committing.

## Evidence

[Decision 0165](../decisions/0165-encode-planning-record-columns.md) owns alternatives. The [codec](../../src/engine/mechanics/compact-planning-records.ts) and its [tests](../../src/engine/mechanics/__tests__/compact-planning-records.test.ts) own representation and validation evidence. Prospective results remain in the existing experiment record.
