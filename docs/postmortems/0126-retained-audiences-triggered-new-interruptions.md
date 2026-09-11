# Retained audiences triggered new interruptions

Artifact-Version: 1

## Executive summary

The engine used the audience of retained, non-due Activity footprints to trigger post-boundary pauses. Complete dependency context was mistaken for new interaction evidence. A player who had kept the current action was asked to decide again at the next short checkpoint, although the external Activities had not reached their next boundaries.

## Summary

In `integrated-player-06`, the second step advanced from one to two seconds and adjudicated only the player's lodging inquiry. The dependency closure included 37 retained Activities. Two footprints named the player in their audience while their owners' next checkpoints remained at ten seconds. The engine paused 22 Activities, including the player, under `relevant_committed_observation`; there were no candidate events, and the pause calculation ran before observation rendering. This prevented the recorded player run from continuing to its goal. It does not establish that removing the interruption alone would produce a lodging answer.

## Timeline

- Instance `d230bd98-97c4-44f3-8994-29b14be03ef4`, execution `87e5cf89-3465-4499-887a-f8e7f41e6b7d`, candidate Ledger sequence 1395 preserves the source state, full dependency closure and resulting dispositions.
- Source review distinguished the sole adjudicated player action from the retained footprints of `sheriff-barris-ironoak` and `canon-brannoc`; both named the player in their audience but were not adjudicated at that boundary.
- A two-Agent real-engine regression used one-second and ten-second checkpoints. The ten-second Activity remained in the dependency closure, and the old implementation paused the one-second Activity at second two. A same-time control preserved a legitimate pause caused by the other Activity's due action.

## Root cause

Both the reference producer and CanonicalCommitter flattened audience membership from the entire interaction dependency closure. The closure deliberately contains non-due Activities for conflict and premise validation. Its scope therefore exceeds the set of interactions occurring at the boundary. Matching implementations accepted the same mistaken pause, while earlier tests covered completely unrelated work and current action-triggered interruption without this intermediate case.

## Guardrails

[Decision 0178](../decisions/0178-separate-boundary-triggers-from-activity-context.md) limits this automatic audience rule to current action, Timer and Condition nodes. All retained context, source-footprint validation, onset reaction and continuation checks remain. Execution contract 8 identifies the changed fixed validation rule, with eager-reference version 22 and integrated diagnostic version 5.

The [boundary regression](../../src/engine/algorithms/eager-reference/__tests__/boundary-interruption.test.ts) runs through SimulationEngine and CanonicalCommitter. It preserves unequal checkpoints, source actions and replay, rejects forged pauses and changed retained footprints, and retains current due-action interruption. Existing [engine safeguards](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) retain timer, actual interaction and invalidated-premise coverage. Fresh full-player qualification remains required by the [efficiency contract](../specs/0122-player-action-efficiency.md).
