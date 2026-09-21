# Persistent Control Reintroduced Indexed Intention Generation

Artifact-Version: 1

## Executive summary

The persistent-intention diagnostic integrated an older indexed generation interface instead of the available recursive producer. Real bootstrap responses repeated avoidable node and target bookkeeping errors, so execution never reached a player action. The composed diagnostic must be tested through its actual recursive wire contract and deterministic lowering.

## Summary

A full-world trial on commit f3d04532 rejected all six initial eight-subject bootstrap batches. The run recorded ninety-three physical requests before operator cancellation, including eighty-seven requests with repair lineage. These counts include split recovery and are not a count of independent agent failures. No world instance or player action was committed. One early response selected three targets but referenced indices two and six. Other responses contained unreachable nodes, unused targets and nested children where the schema required numeric references.

## Timeline

- [Decision 0210](../decisions/0210-compile-nested-intentions-to-indexed-programs.md) established recursive model output with deterministic internal indexing.
- The persistent continue/replace adapter wrapped indexed generation and used an indexed fixture in its host test.
- Persistence, rollback and restart checks passed, but the composed producer's representation choice was not guarded.
- Real bootstrap repeated the known representation failures and the operator stopped dispatch before any player action.
- Registered bootstrap regressions using recursive output failed for the persistent composition while passing for the existing recursive diagnostic.

## Root cause

The execution cursor legitimately consumes an indexed internal program. The adapter incorrectly treated that storage format as the model's generation format, reintroducing redundant node IDs, child references and action-level target indexing. The host fixture matched that implementation, so it proved persistence without detecting the integration omission. Neither successful canonical tests nor an internal graph validator established that the selected producer retained the previously implemented representation boundary.

## Guardrails

The persistent control adapter wraps the existing recursive producer and decoder. Its private context reconstructs the same nested representation; indexing remains deterministic engine work. The [registered bootstrap tests](../../src/engine/benchmarks/step-efficiency/agent-recursive-intent.test.ts) exercise both diagnostic compositions through the model gateway, resolve the complete wire document's references, preserve complete plans and still reject another subject's local target. The [WorldHost test](../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm.test.ts) exercises that recursive control wire through continued execution, guard failure and database restart. These guardrails establish the integration contract, not real-model semantic correctness or player latency.
