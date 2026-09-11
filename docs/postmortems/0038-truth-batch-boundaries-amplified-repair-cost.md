# Truth Batch Boundaries Amplified Repair Cost

Artifact-Version: 1

## Executive summary

Full-world STEP-E1 trials exposed three batching defects that compiler-only experiments and small happy-path tests did not cover: slightly different verifier catalogs repeated complete arrays, one malformed result invalidated otherwise usable slots, and changing physical batch owners broke logical audit combination. No world step committed in the affected trials. The corrections preserve full slot context and strict validation rather than reducing action count or semantics.

## Summary

In `discovery-e1-01`, a five-slot verifier request contained 979416 message tokens plus a 131072-token output allowance and was rejected by the provider's 1048576-token context limit. Its missing usage remains unknown with the complete budget ceiling held. In `discovery-e1-03`, the revised catalog encoding passed that boundary, but malformed member results triggered whole-envelope recovery and a batch-to-singleton repair could throw an audit identity error. Model plan errors also remained; fixing the engine defects does not certify semantic or gameplay success. The experiment report owns costs and trial outcomes.

## Timeline

- The initial shared-context implementation passed exact JSON round trips and a small real-engine happy path.
- The first paid full-world trial exposed verifier catalogs that differed only through newly introduced component plan references.
- Catalogs became reversible handle dictionaries with original per-slot ordering, and the second paid trial reached plan validation without that overflow.
- Recorded rejections and the owning coordinator showed whole-batch schema recovery and incompatible logical audit identities across physical batches.

## Root cause

The codec treated arrays as indivisible, so adding one plan to a catalog prevented any sharing of that catalog. Offline capacity evidence covered initial plan requests rather than the changed catalogs at verification. Round-trip correctness established information preservation but did not establish adequate compression at every production phase.

The provider retained parsed rejected output in `ModelOutputError.rawValue`, but the coordinator only inspected individual slots after the provider accepted the complete typed batch. A bad member therefore bypassed slot isolation. Logical callers also received the physical batch's subject and prompt identity; semantic repair could change the batch grouping or become a direct request, causing strict audit combination to reject otherwise related attempts.

## Guardrails

- [Catalog codec tests](../../src/engine/mechanics/__tests__/shared-batch-context.test.ts) exercise nearly identical catalogs, different ordering, unknown additions and exact reconstructed context hashes.
- [Coordinator tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) preserve valid results from a schema-rejected envelope, reject ambiguous slot mappings, and combine a logical slot's batched and direct repair audits while preserving physical invocation identities.
- [Real-engine tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) exercise production schema names, atomic cancellation, canonical random ordering and replay.
- [The experiment contract](../specs/0026-full-step-efficiency-experiment.md) requires full-world trajectories, actual transport accounting and unknown billing reservations; byte savings alone cannot authorize promotion.
