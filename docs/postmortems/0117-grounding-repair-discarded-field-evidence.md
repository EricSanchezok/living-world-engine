# Grounding repair discarded field evidence

Artifact-Version: 1

## Executive summary

A continuous-world diagnostic committed one boundary and then rolled back the next settlement after interaction grounding exhausted its repairs. Known catalog handles were repeatedly selected for disallowed field purposes. The repair boundary discarded exact field evidence and the preceding candidate.

## Summary

The failed settlement made 58 grounding HTTP calls, with 31 rejected responses and 17,124,497 input tokens. Twenty-five rejections reported an Agent used as a conflict dependency; local target and action handles also occupied conflict fields. These were interaction-grounding requests for due work, distinct from initial Action Compilation. The first committed player feedback had already exceeded the latency target, so fixing the later failure alone cannot establish fluent gameplay.

## Timeline

- The first player action received a committed world response after 469.47 seconds.
- The next temporal settlement dispatched due-action grounding requests.
- The materializer stopped at the first disallowed reference use.
- The grounding classifier retained only error prose; the context builder supplied null values, a generic task path and no previous output.
- Several actions repeated the same disallowed type through their repair ceiling, rolling back settlement.
- Real gateway regressions reproduced missing previous candidates for both materializer and gateway reference failures.

## Root cause

The shared semantic loop already retained the rejected value, and the reference resolver already supplied exact selected handles and allowed uses. The grounding role projected neither into its repair context. Its fail-fast materializer also hid independently detectable errors in other fields. Existing tests exercised dependency graph behavior and Action Compilation diagnostics, leaving the due-action grounding HTTP boundary uncovered.

## Guardrails

The [grounding repair contract](../specs/0118-complete-grounding-repair-evidence.md) preserves all independent reference failures before dependent validation. The [gateway regression](../../src/engine/mechanics/__tests__/action-grounding-repair-evidence.test.ts) verifies paths and selected values against the exact previous output, unchanged state and catalogs, valid-control equivalence, and unknown-reference recovery.

## Limits

Complete diagnostic evidence does not guarantee model recovery or adequate dependency coverage. No invalid reference is converted, no recovery ceiling is raised, and no world state is accepted on the strength of formatting alone. First-feedback latency, continuous settlement and source semantics require separate whole-world evidence.
