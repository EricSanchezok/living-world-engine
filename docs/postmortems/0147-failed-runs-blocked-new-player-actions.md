# Failed Runs Blocked New Player Actions

Artifact-Version: 1

## Executive summary

A failed WorldRun could retain an active player Activity and reject every later action as a policy-ownership error. The player still owned the external policy. New participant input now starts a distinct run after a terminal failure while preserving the original failure evidence.

## Summary

STEP-E3 run `5778e4d9-29ee-4c69-a70f-583a0ee7485e` failed after a committed checkpoint. Its two later inputs received HTTP 409 without any model request. Participant and policy bindings were unchanged; the active Activity kept the player outside the ordinary decision set.

## Timeline

- A long player action committed a checkpoint and remained active.
- A subsequent model failure terminated the run without changing that committed Activity.
- New input passed participant ownership and revision checks.
- Decision eligibility excluded the busy Agent, and the override handled only paused runs.
- The host returned a misleading ownership error and could not start a new action.
- A real WorldHost regression reproduced the same sequence with a controlled transport failure after the first checkpoint.

## Root cause

Run termination and Activity termination are separate boundaries. The action admission path assumed a failed run would leave a decision-eligible participant, but rollback correctly retained the last committed active Activity. Existing recovery tests failed before an active player Activity existed.

## Guardrails

[WorldHost](../../src/server/world-host.ts) admits a new external intent after a failed run using the existing principal, revision and submission checks. It does not relabel the old failure as completed. Input admission only updates control state; the ordinary next-step commit owns Activity interruption.

The [host regression](../../src/server/__tests__/world-instance-host.test.ts) verifies retained failure evidence, rejected unauthorized and stale requests, duplicate submission idempotency, stale callback fencing, actual interruption at the next commit, replay and Ledger integrity. The [runtime reference](../game-design/engine-runtime.md#worldrun-与暂停恢复) owns the current behavior.
