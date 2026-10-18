# Local replies starved a participant continuation

Artifact-Version: 1

## Executive summary

A full Fanren cost trial admitted the opening speech of a compound player request but never selected its pending timed wait. Ready local NPC work took precedence at every later boundary. The world continued spending model calls and advancing time while the player's authorized continuation stayed ready. Concurrent eligibility fixes the scheduler without forcing NPC behavior or adding a classifier.

## Summary

Instance `050a6c2b-f1e6-49a8-b92a-4a68c307e4a9` completed its first request. Its second asked the player to speak to their mother, then wait two minutes. There was only one player interpretation for that request, at `2026-10-18T17:08:01.132Z`; its speech committed, but no player wait frame followed. At revision 11 the player still had an active submission, ready status and no activity. NPC work advanced another 600 seconds. The harness stopped the whole trial at 70 HTTP requests; 67 had completed audits and three had unknown in-flight usage. Correct replay did not establish correct scheduling or acceptable cost.

## Timeline

1. The initial request completed with fewer calls than the baseline, preserving the master's authority over entrusted herbs.
2. The next request produced player speech and queued its continuation.
3. Reactions and local work remained eligible; each selection chose those actors instead of the player.
4. Ledger inspection distinguished player-reading invocations from publication checks and confirmed the missing continuation.
5. The real engine regression failed because the player's reading count remained one at the next eligible boundary.
6. Selection now admits the pending continuation alongside eligible reactions; the regression verifies the wait deadline, NPC dialogue, restart and deterministic replay.

## Root cause

The scheduler used mutually exclusive priority branches: reactions first, pending players second. This was intended to retain direct replies and exclude global background work. After local autonomous work was included in the reaction set, a busy nearby group could keep that branch nonempty indefinitely. The existing fairness test asserted NPC participation but never asserted timely admission of the player's second operation, so it certified only one side of fairness. Model self-reports and canonical time advancement could not detect the missing selection.

## Guardrails

The [local-activity engine regression](../../src/engine/direct/__tests__/local-activity-window.test.ts) now asserts that an already authorized participant continuation and eligible NPC work are selected at the same committed boundary. It verifies a bounded wait's absolute deadline, retained dialogue, exclusion of distant readiness, restart and replay. [Spec 0207](../specs/0207-relevant-npc-wakes-and-model-cost-policy.md) preserves this admission rule. `direct-world@20` pins the behavior change; fresh instances are required for the new producer, with no migration or old scheduler branch.
