# Dependency write upgrade escaped closure

Artifact-Version: 1

## Executive summary

A controlled source-output review exposed a gap in the component isolation guard: an operation could write a resource declared only for reading without triggering the existing global-resolution fallback. The guard checked resource membership after discarding access modes.

## Summary

Two actions that declare only reads of one object remain independent. If one resolution moves that object while the other observes it without a physical delta, comparing their operation footprints finds no conflict. The declaration guard must detect the first resolution's write upgrade. This reproduction establishes an isolation defect; the originating experiment did not establish a corrupted world commit.

## Timeline

- A shared-grounding experiment produced a source action whose object was declared only as a read despite a possible mutation.
- Controlled conflict-graph comparisons showed that such declarations could separate related tasks.
- Review of the post-resolution guard found that declared reads and writes were combined before testing actual writes.
- A regression using the loaded world, the real graph builder and real operation footprints failed on that upgrade while a no-delta observer remained separate.

## Root cause

Resource coverage was treated as equivalent to access coverage. The independent operation-overlap check could detect two generated mutations but could not recover a semantic read that produced no operation. Existing graph tests covered declared read/write conflicts without exercising a generated write that exceeded a read-only declaration.

## Guardrails

The [dependency regression](../../src/engine/mechanics/__tests__/action-dependency.test.ts) requires actual writes to belong to the component's declared potentially affected resources. Actual reads may belong to either declared set. It covers an independent no-delta observer, correctly declared writes, undeclared destination reads and explicit global fallback. Both existing [resolution closure checks](../../src/engine/algorithms/eager-reference/eager-reference.ts) consume this guard: initial closure restarts global adjudication and repaired final closure rejects a scope expansion. No action is converted or accepted to avoid that recovery.

This enforces the existing [causal interaction contract](../specs/0005-causal-activity-interactions.md); it does not prove semantic reads are complete, introduce containment inheritance, or claim lower model cost. Prospective full-world trials must measure any additional fallback work.
