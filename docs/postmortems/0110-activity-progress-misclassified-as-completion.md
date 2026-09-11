# Activity progress misclassified as completion

Artifact-Version: 1

## Executive summary

A complete-player execution exhausted transition repairs because the component guard treated every effect citing an active action as a premature completion. Its prompt also required scheduled completion for modes with no completion schedule. Mode-specific instructions and the existing causal validation pipeline replace the inconsistent rules.

## Summary

The player execution returned model responses but committed no world feedback. The final transition proposed continuing outcomes with events, then repeatedly received a generic completion-boundary error. Some proposed events also lacked convincing occurrence evidence, so accepting the entire recorded response would not establish correctness.

## Timeline

- Event-boundary execution deferred scheduled completion and trusted receipt effects.
- Goal-directed activities and source-bound interval evidence distinguished checkpoints, completion and supported partial effects.
- The transition task retained an unconditional completion-boundary sentence and the component retained a blanket effect veto.
- A real player run exposed both conflicts after repeated transition repair.
- Controlled real-entry tests reproduced rejection of a valid intermediate placement and event before causal review.

## Root cause

The guard used source-action activity status as a proxy for the semantic meaning of each consequence. It could not distinguish reaching an intermediate state from completing the entire source task. Prompt examples and generic tests covered continuing no-effect actions and completed actions, leaving supported partial changes untested.

## Guardrails

[The repair contract](../specs/0109-align-activity-progress-and-completion.md) preserves scheduled status and trusted receipt deferral while routing interval consequences through their existing validation owners. [Real-entry tests](../../src/engine/algorithms/eager-reference/__tests__/activity-partial-effects.test.ts) cover supported progress, early completion, false witnesses and a bound review rejection with rollback. [Goal/conditional tests](../../src/engine/algorithms/eager-reference/__tests__/conditional-completion.test.ts) distinguish supported completion from continuing work and false success. Test providers validate orchestration, not a real model's ability to judge all open semantics.
