# Logical Repair Without Its Rejected Candidate

Artifact-Version: 1

## Executive summary

A complete planning response admitted most actions but left two logical components invalid. Repair requests named exact plan fields without including the preceding plans. Subsequent model responses rewrote formerly valid plans and introduced additional reference and effect failures.

## Summary

The source state and actions remained available, but output-relative issue paths did not identify a candidate the model could inspect. Richer diagnostics alone could not supply that missing object. The observed regressions support fixing the feedback contract; they do not prove that candidate replay eliminates model errors.

## Timeline

- The frozen selector probe retained 29 of 41 actions from its first response.
- Check-effect diagnostics exposed two missing stakes together.
- The diagnostic recovery probe exhausted two new calls without improving admission.
- Request inspection showed no rejected candidate beside the local plan-index issues.
- The loop and Truth request builder gained detached, source-bound candidate evidence, verified through a real loaded-world step and physical codecs.

## Root cause

The [semantic loop](../../src/engine/models/semantic-repair.ts) retained issues and invocation lineage but discarded rejected values. The [Truth builder](../../src/engine/mechanics/truth-engine.ts) reconstructed repair from those issues and original inputs. Uncommitted plans were correctly absent from canonical state, but there was no separate repair-data location for them.

## Guardrails

[Spec 0037](../specs/0037-truth-rejected-candidate-repair.md) owns the exact candidate, binding, clearing and output-ownership contract. Loop regressions cover malformed values, null, unavailable output, mutation and concurrency. Full-step tests verify the two rejected plans are present in repair while committed plans remain empty, followed by atomic commit and replay. Shared and unfactored batch tests preserve ownership; selector tests preserve reversible representation and canonical hashes. Paid recovery, latency, token overhead and source semantics remain independently measured.
