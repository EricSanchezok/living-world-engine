# Unused null tool blocked player speech

Artifact-Version: 1

## Executive summary

A real-model medic opening stopped before asking two injured characters for consent. The intended speech was valid, but the language reading included `tool: null`. Structural validation rejected that unused field before the existing executed-branch validator could discard it.

## Summary

Both the initial reading and its one permitted repair used a null tool. The run retained its earlier committed speech and ended with a local model-task failure. No treatment, consent or resource consumption was fabricated. The reading schema accepts null catalog fields; the existing branch validator still requires valid catalog choices for executed parameters.

## Timeline

- On 2026-10-17, real-model twelve-origin acceptance reached the medic's second requested speech.
- The Ledger recorded two `invalid_type` issues at `action.tool`; both rejected readings otherwise expressed the pending consent question.
- A simulation-entry test reproduced the failure using a raw language response with a null tool.
- Accepting null in the outer catalog-field shape lets speech complete without a repair; a paired test still rejects a null observation scope for an actual observation.

## Root cause

The branch validator intentionally discards fields that the selected operation does not execute. Its outer Zod shape allowed an omitted field or a string, but rejected null before that logic ran. Existing coverage supplied invalid string references on unused branches and therefore missed the structural inconsistency. Repairing the same model spelling was unnecessary work because no tool participates in speech.

## Guardrails

- [Simulation-entry regressions](../../src/engine/direct/__tests__/runtime.test.ts): “validates nullable catalog fields only on the executed … branch” verifies delivered speech with one reading, rejection of an invalid active observation scope, unchanged truth on failure and exact replay.
- [Action reading validator](../../src/engine/direct/action-reading.ts) retains one executed-branch validation path; accepting absence never selects an entity, grants permission or commits an action parameter.
