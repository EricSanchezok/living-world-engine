# Preparation failed before sibling audits

Artifact-Version: 1

## Executive summary

An overlapping preparation returned failure before its sibling model work finished. WorldHost closed the execution while that work still needed to persist evidence. Index integrity checks remained healthy because they check recorded rows, not whether every dispatched model call reached a recorded terminal state.

## Summary

The `integrated-player-04` diagnostic dispatched 18 inference HTTP requests, including four repairs, but retained only 17 audits. The missing sibling repair had a request event and no recorded response or audit. Its token usage remains unknown; the historical result is not rewritten or counted as zero. The player's action failed before any world-step commit.

## Timeline

- Instance `2f44a07a-3f81-47fb-9a27-ee3b817da311`, execution `051ff12c-b99e-47a1-aef1-1d4d647c6cb5`, preserves the original failure. The instance Ledger spans sequences 1–325.
- Invocation `rt:model-audit:abc5960de8afcee561825bfab706c68ea3ae635c32e27ebf7e85355675ec3374` started at sequence 309 and dispatched at sequence 312. Its repair concerns a resumed Agent's action; another compilation branch exhausted recovery first.
- The diagnostic waited for provider promises after WorldHost returned, but that was too late to keep the execution writer open.
- A deterministic test through actual WorldHost submission held one sibling compilation in flight, failed the other, and observed the execution already marked failed before releasing the sibling. The regression failed on the old implementation.

## Root cause

`prepareStep` joined known-action compilation and resumed cognition/compilation with `Promise.all`. Its first rejection escaped while the other branch remained active. WorldHost legitimately treated that return as the end of engine work and closed the execution. The existing overlap test asserted that failure should return before releasing the pending mind call, preserving the wrong lifetime boundary.

## Guardrails

Execution producer version 21 retains the original first failure but waits for both already-started preparation branches to settle before returning it. The existing preparation-failure flag still prevents a pending cognition result from starting fresh compilation after its sibling fails. Successful scheduling, output, batching and model requests are unchanged. The diagnostic producer advances to version 3; old instances are not migrated.

The [WorldHost regression](../../src/server/__tests__/world-instance-host.test.ts) proves the execution stays open while a sibling is in flight, records the sibling audit before the terminal failure, issues no replacement compilation, and preserves the exact source state without a commit. The [overlap tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) retain success-path request equality and verify that failed known work cannot dispatch a new compilation after pending cognition settles.

This fix does not reconstruct the missing historical usage or certify all unrelated asynchronous paths. The [full player contract](../specs/0122-player-action-efficiency.md) still requires complete actual gameplay, near-zero repair and measured end-to-end latency.
