# Fresh Condition IDs Forced Global Readjudication

Artifact-Version: 1

## Executive summary

A complete player diagnostic reached fourteen adjudicated components, then abandoned them for global readjudication. Two trusted effects created conditions under already-declared affected subjects, but exact-key dependency validation required the future condition IDs in the earlier grounding output. The global request exceeded the local input limit before dispatch.

## Summary

Execution eba08aae-5604-4485-a448-f0cd621f9a86 used forty-eight autonomous NPCs and one external player. The player waited 357.370 seconds with no feedback or world commit; the run issued forty-five model HTTP calls. Its global request measured 50,349,233 bytes against the configured 4,000,000-byte limit. This observed failure does not establish the latency or semantic correctness of a successful run.

## Timeline

- Transition sources at Ledger sequences 920 and 929 covered twelve and two logical slots respectively, totaling forty-nine actions.
- All fourteen parsed transition outputs had no direct operation. Two automatic full resolution plans supplied trusted condition effects on different existing subjects.
- Both subjects already appeared as declared entity writes, but neither generated condition ID existed in the initial state.
- The exact dependency comparator rejected both writes. Adding only the generated condition key to each diagnostic declaration eliminated its rejection, isolating the identity mismatch without executing a world commit.
- The scheduler attempted global planning at source sequence 949. The normalized error at sequence 951 reported the input byte ceiling; the oversized request was not dispatched.
- A structural replay of all fourteen recorded plan/dependency groups under the subject-scope validator found no remaining exceeded group or conflicting pair. This is bounded structural evidence, not a successful player replay.

## Root cause

Grounding expressly permits only existing references and asks for the existing objects underlying future effects. The late coverage validator treated a generated condition ID like an existing record overwrite. Those contracts cannot both be satisfied by ordinary fresh creation. Broad global fallback hid this disagreement by granting every dependency a global scope, repeating unrelated planning and amplifying an already duplicated source inventory.

Existing dependency tests protected exact record writes and moving entities but did not cover new trusted condition effects through the scheduler. A naïve exemption for all new IDs would also miss readers of the same subject whose proposals contain no physical delta.

## Guardrails

- [Fresh condition coverage and scope conflicts](../../src/engine/mechanics/action-dependency.ts) require an existing subject with an explicit entity write and compare creations against other components' declared and actual subject accesses. Existing conditions still require their own write keys.
- [Boundary regressions](../../src/engine/mechanics/__tests__/condition-creation-dependencies.test.ts) cover read-only and wrong-subject permissions, overwrites, duplicate IDs, empty-delta readers, and old and new condition subjects.
- [Engine and committer regressions](../../src/engine/algorithms/eager-reference/__tests__/condition-creation-scope.test.ts) commit and replay the actual condition, retain RNG, require fallback for a same-subject condition reader, and repeat validation after final repair. Independent-creation cases fail with the original comparator.
- The [creation contract](../specs/0154-subject-scoped-condition-creation.md) keeps semantic review and complete player qualification separate from mechanical scope acceptance.
