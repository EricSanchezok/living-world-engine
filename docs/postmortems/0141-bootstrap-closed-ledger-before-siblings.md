# Bootstrap Closed Its Ledger Before Sibling Calls Finished

Artifact-Version: 1

## Executive summary

A full-world diagnostic stopped after systematic bootstrap output failures. One batch propagated the stop while sibling calls were still returning, so the host marked their shared Execution failed before those calls could persist their evidence. A late write then crashed the process. Parallel batch owners must drain all started branches before returning failure.

## Summary

Execution c4492a74-964e-4eb1-922a-92952a061a42 recorded ninety-three physical requests but only ninety durable responses. Its bootstrap rolled back after operator cancellation and no world instance or player action was committed. The process exited with `execution is already terminal`, preventing the experiment's normal result file from being written. Database integrity checks passed for the evidence that had actually persisted; that did not establish completeness.

## Timeline

- Six initial eight-subject bootstrap batches were rejected, followed by repairs and recursive splitting.
- The operator stopped later dispatch after repeated structural rejections.
- One batch propagated the terminal configuration error. Bootstrap rolled back and the shared Execution became failed.
- A sibling emitted additional model evidence against that terminal Execution, causing an uncaught error and process exit.
- Controlled batch and WorldHost regressions reproduced early rejection while a sibling remained gated in flight.

## Root cause

The batch tree and cognition profile owner used fail-fast `Promise.all`. Rejection ended the owner's lifetime but did not end its sibling promises. The experiment's provider-level pending set could not repair this ownership mismatch because algorithm branches also validate results and emit events after a provider promise resolves. Existing tests covered one failed call and compilation overlap, but not a failed bootstrap with a still-running sibling or nested repair branch.

## Guardrails

The [batch owner](../../src/engine/algorithms/eager-reference/eager-slot-batching.ts) preserves the first failure, drains every already-started branch, and fences new recovery dispatch after a terminal failure. Cognition profile/purpose owners and private guard batches use the same settlement boundary. The [batch regression](../../src/engine/algorithms/eager-reference/__tests__/eager-slot-batching.test.ts) checks delayed rejection and absence of later repair calls; the [WorldHost regression](../../src/server/__tests__/world-instance-host.test.ts) verifies that a sibling's audit precedes the terminal event, rollback retains the source state, and no instance is committed. [The batching contract](../specs/0007-eager-reference-slot-batching.md) owns these lifecycle requirements.
