# Shortlist Pruning Falsified State References

Artifact-Version: 1

## Executive summary

Action Compilation retrieval replaced known references outside its shortlist with null. Selected entities consequently appeared to have no location, and arrays lost both pruned references and genuine null entries. This was a deterministic input-fidelity defect, independently of the model's remaining action-scope errors.

## Summary

Four STEP-E2 full-world compiler requests each retained 372 candidates. Comparing their captured full contexts with actual HTTP contexts found 66, 85, 93 and 81 nonempty object fields changed to null; this count excludes array changes. Fourteen location fields changed in the first batch alone. Curator Iseult Vale and Thil the Cowled had different canonical placements, but their selected records both presented null placement references.

## Timeline

The stopped `trajectory-e2-01` captured full source contexts and actual requests before any game step committed. Debug CLI inspection verified the Ledger artifacts and state bindings. A separate paired projection diagnostic improved formal/reference-valid batches from 4/12 to 10/12 but retained the source-scope veto; it did not establish gameplay improvement. The deterministic foundation repair therefore preserves the source facts while leaving model behavior and full-world acceptance separately assessed.

The representative public invocation is `b19dd856-c1b4-41e4-859c-517ec9222a62::rt:model-audit:222f563b8d7050f69665d63f73814367379d4084d7b82add39c26cd736c89a3c`, Ledger sequence range 110–209, capture sequence 204, artifact `c41b89a203e736ebd039cf6d96ea814188f769d4e4a30cfe0641a43eddf603b3`. Source-bound extracts and comparison evidence remain under `.livingworld-benchmarks/experiments/step-efficiency/v2/evidence/shortlist-pruning-01/`; the experiment record indexes the raw local evidence.

## Root cause

The recursive pruning function used null as an internal omission marker and then filtered nulls from arrays. That representation conflated retrieval exclusion with source absence. Tests constrained candidate budget and output membership but did not check the truthfulness of selected candidate details.

## Guardrails

The [runtime regression](../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime.test.ts) exercises the real retrieval boundary and verifies unchanged selection, immutable source context and non-null read-only references. The [projection tests](../../src/engine/benchmarks/step-efficiency/shortlist-evidence.test.ts) cover different placements, ordered arrays, genuine nulls, source binding and rejection of snapshot output references. [Decision 0115](../decisions/0115-preserve-shortlist-reference-evidence.md) explains why this representation preserves evidence without widening the executable namespace. Actual continuous-world tests still own semantic and gameplay acceptance.
