# Transition Coverage Feedback and Late Validation

Artifact-Version: 1

## Executive summary

A missing action outcome triggered observation generation before its inevitable rejection. The resulting repair message incorrectly prescribed `continuing` from the Activity's pre-step status, even when the selected boundary completed that Activity.

## Summary

STEP-E1 trajectory 09 compiled all 48 actions on the first attempts but failed without a state commit. Its terminal transition followed an omission, misleading continuation feedback, a completion rejection, and an invalid final schema. The experiment record owns the input identities, request evidence and costs. Other observed batch and observation failures remain separate problems; this repair does not establish complete-game success.

## Timeline

- A transition omitted an assigned Activity outcome.
- The engine rendered observations before checking complete action coverage.
- Coverage validation inspected pre-step active/paused Activities and told the model to emit `continuing`.
- The engine's authoritative completion-boundary check rejected that status on the next attempt.
- A real SimulationEngine regression reproduced both the unnecessary observation call and the misleading repair instruction at a completion boundary.

## Root cause

Outcome cardinality was grouped with envelope validation after observation rendering, although it depends only on assigned actions and the candidate's outcomes. Its diagnostic also conflated an Activity's state before the step with the status required at the selected temporal boundary. Tests of individual temporal guards did not exercise the omission-to-repair path and its model-call ordering.

## Guardrails

The shared coverage check in [Truth Engine](../../src/engine/mechanics/truth-engine.ts) rejects missing, extra and duplicate action outcomes before receipt settlement and observation generation. Final envelope validation retains the same coverage check and all existing validation. Missing-outcome feedback identifies the omitted actions and directs the model to the supplied trusted completion boundary without asserting that all previously active Activities must continue.

The [real execution regression](../../src/engine/mechanics/__tests__/transition-validation.test.ts) verifies that incomplete proposals trigger no observation calls, that completion-boundary repairs do not receive the false continuation instruction, and that the repaired step commits and replays. Duplicate outcomes remain rejected. Expensive model output is scripted; the world loader, algorithm, temporal scheduling, validation, commit and replay paths are real. No model output is filled in and no action is removed.
