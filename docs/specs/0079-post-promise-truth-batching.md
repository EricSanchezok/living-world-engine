# Post-promise Truth Batching

Artifact-Version: 1
Status: Approved

## Intent

Collect independent canonical transition requests released by the ordered commitment stream before dispatching an underfilled physical batch. The existing next-microtask flush can run between consecutive promise continuations, producing single requests despite compatible contexts and available concurrency. The user's continuing optimization authorization covers a prospective scheduling candidate with unchanged model capability and semantic scope.

## Contract

An explicit post-promise-v1 flush boundary on the shared Truth batching child schedules an underfilled flush after the current promise jobs drain, using a Node microtask followed by nextTick. Full batches still dispatch at the existing slot ceiling. This introduces no timer window, wait for all world components, cross-step cache, retry or network call. Requests that depend on unfinished external work do not block ready requests.

Retain every existing grouping boundary, cancellation identity, schema, complete context, per-slot catalog, RNG commitment and output validation. The reversible shared-context codec and physical request contract are prerequisites. Preserve twelve slots and current repair limits. The selected experiment records the scheduling option in its algorithm identity; historical candidates without it retain their schedule. Different physical grouping is a new model-visible trial condition and cannot inherit prior success or semantic approval.

## Plan

Reproduce fragmentation using the real OrderedRandomStream and TruthBatchCoordinator, then activate the post-promise boundary in the prospective integrated candidate. Reuse the existing batch representation and codecs. Measure complete recorded transition inputs through the real preparation/gateway boundary without paid dispatch. Run targeted tests and check:fast before committing.

## Verification

Transitions released by successive ordered commitment promises must coalesce without changing their complete reconstructed inputs or decoded outcomes. Full batches must respect the slot ceiling, partial batches must settle without waiting for later I/O, and incompatible revisions/profiles/signals remain separated. Exercise a registered game step to verify the selected configuration reaches the real component. Frozen-source offline results establish scheduling and codec behavior only; fresh paid gameplay remains subject to full budget and source-review admission.

## Evidence

[Transition integration tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) reproduce the ordered release boundary. [Coordinator tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) own isolation and failure delivery. [Decision 0143](../decisions/0143-post-promise-batch-dispatch.md) records the scheduling source and alternatives.
