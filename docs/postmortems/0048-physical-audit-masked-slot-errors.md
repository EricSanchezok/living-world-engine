# Physical Audit Masked Slot Errors

Artifact-Version: 1

## Executive summary

A physical batch's generic schema error overwrote a rejected logical slot's precise field diagnostics at the semantic repair boundary.

## Summary

STEP-E1 trajectory 10 reached repair with only a generic provider schema message for two resolution components. The batch coordinator preserved each slot's Zod error as a cause, but inherited the physical invocation's generic issues in the logical audit.

## Timeline

Wrapped-cause recovery exposed precise validation issues in direct calls. Full-game batch evidence still showed empty error paths. A coordinator-to-repair-loop regression reproduced the override: the local `plans` type error became a generic physical error before the next model request.

## Root cause

The semantic repair loop deliberately prefers audit diagnostics over error classification to preserve provider reference metadata. The salvaged slot's audit retained the physical envelope's diagnostics, so that precedence suppressed its own schema error. An error cause alone was insufficient to preserve repair information.

## Guardrails

The [batch coordinator](../../src/engine/mechanics/truth-batch-provider.ts) projects a rejected logical slot's schema issues into its cloned audit, using slot-local field paths. The physical audit and raw request/response evidence remain unchanged, as do accepted slots, batch cardinality and repair limits. The [regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) drives a physical schema rejection through slot salvage and the real semantic repair loop, verifying that the next request receives the local field error instead of the physical summary.
