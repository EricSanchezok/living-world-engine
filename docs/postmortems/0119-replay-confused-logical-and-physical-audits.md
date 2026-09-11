# Replay confused logical and physical audits

Artifact-Version: 1

## Executive summary

Offline replay rejected recorded physical batch outputs because it loaded their identity from candidate audits projected onto logical components. Missing-output and identity errors then entered ordinary semantic recovery, producing expensive work that could be mistaken for normal engine computation.

## Summary

A whole-step CPU diagnostic reached an existing physical planning invocation whose durable request subject was a batch. Its candidate audit used the same invocation ID but belonged to a logical component. Replay compared that logical subject with the new physical request and rejected the recorded response. Subsequent recovery requested outputs that the original execution never generated. These failures establish a replay defect, not an additional failure of the original committed game step.

## Timeline

- A long offline diagnostic prompted investigation of both machine memory pressure and engine computation.
- After a reboot, bounded profiling stopped on the first physical identity mismatch instead of continuing recovery.
- The original Ledger contained a physical `model.audit.persisted` record with the correct batch subject; the replay provider used the candidate's logical projection instead.
- The existing one-agent replay test passed, while extending the same real gateway, engine and Ledger fixture to three agents reproduced the failure.

## Root cause

One physical invocation can be represented by multiple logical audit projections. Candidate audits define which invocation IDs belong to the replayed phase, but do not define physical request identity. Treating missing or mismatched recorded evidence as a generic model error also allowed repair and batch splitting to amplify a diagnostic failure. The single-agent regression did not exercise a physical batch with a different logical subject.

## Guardrails

The [recorded provider](../../scripts/operations/execution-command.ts) selects phase membership from candidates and loads identity, usage and request metadata from durable physical audit events. Missing physical audits reject before replay starts. Missing outputs, duplicate consumption and physical identity mismatches are configuration errors and cannot enter semantic repair. Actual recorded invalid model output retains its existing repair behavior.

The [Ledger regression](../../src/server/__tests__/execution-ledger.test.ts) runs one-agent and three-agent executions through the real engine, verifies identical replayed semantic and state hashes, proves the batched fixture contains distinct physical and logical subjects, and rejects a missing physical audit without starting a child execution. This restores the existing [batch identity contract](../specs/0012-truth-engine-fixed-slot-batching.md). It does not establish gameplay latency improvements or remove the need to profile a correctly bound replay.
