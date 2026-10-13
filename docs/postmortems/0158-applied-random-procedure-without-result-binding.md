# Applied Random Procedure Without a Result Binding

Artifact-Version: 1

## Executive summary

A completed live pressure-test request wrote a deterministic completion label without drawing the authored random result. Draw admission is independent of property binding; an applicable procedure always records its draw, even when the result has no settled destination.

## Summary

The frozen `narrative-continuous-1791929540354` station session selected `a0_random0=apply` and `a0_random0_target0=none`. Ordinary fact selection then wrote `tested`, while the event contained no random request or result. The authored outcomes were `stable` and `unstable`. Replay reproduced the erroneous event correctly; replay equality alone did not establish semantic correctness.

## Timeline

The continuous session first traded for materials and repaired the pump, then requested the authored pressure test. Review of the ninth turn found a deterministic label and no random draw. The retained model decision confirmed applicability but no property binding. Focused restart tests reproduced the missing-binding path before the final confirmation cohort was frozen.

## Root cause

Preparation created random requests inside the bound-property branch and discarded requests when no ordinary operation existed. Two independent decisions had become one conditional code path. An unrelated learned repair capability was also selected for the same equipment during a later test; its applicability question lacked the immediate action beside the declaration.

## Guardrails

[Activity regressions](../../src/engine/direct/__tests__/activities.test.ts) cover a recovered binding, a persistently missing binding with no ordinary operations, one draw across restart and replay, and the unchanged valid binding path. Missing bindings receive one dependent decision after applicability is known. An unresolved binding cannot substitute an ordinary fact label for a sampled result. Capability matching receives the actual action and distinguishes its immediate method from the actor's broader goal. The [runtime reference](../game-design/direct-runtime.md) owns the contract. Debug doctor for the retained failed trial reported no missing or orphaned evidence.
