# Repeated Activity Settlement State Clones

Artifact-Version: 1

## Executive summary

An isolated 48-Agent, three-step profile attributed repeated full simulation-state copies to activity settlement in both candidate assembly and canonical commit. Each affected activity cloned the complete world, including accumulated history, before evaluating read-only continuation assertions.

## Summary

The loop then replaced the cloned activity table with another clone of the currently settled activities. The unchanged world data was copied once per affected activity, although assertion evaluation only reads it and returned disposition evidence is separately detached.

## Timeline

- Continuous deterministic steps exposed growing local work even with zero model repairs.
- Call-stack profiling located full state copies inside the activity settlement loop in both execution and commit paths.
- Source review confirmed that continuation assertion evaluation is read-only and disposition construction clones observed evidence before returning it.
- Settlement now constructs one read-only state view with the current activity table and shares unchanged world data for all affected activities.

## Root cause

Whole-world copying was used to construct a per-activity evaluation view. This duplicated unrelated cognition and history with each iteration. The required changing input was the settlement-owned activity table, rather than a new copy of all world data.

## Guardrails

The temporal result remains a detached copy. Activities settle in the existing sorted order, and the evaluation view references the current settlement-owned table so earlier changes remain visible. Assertion evaluation must remain read-only. Each disposition clones assertion results and observed values before they escape, preserving separation between caller-owned world state and mutable result evidence. No view survives a settlement call.

[Temporal tests](../../src/engine/mechanics/__tests__/temporal.test.ts) cover blocking and interruption across pre/post states, input preservation after returned evidence and activities are mutated, and a subsequent call observing changed facts. [Engine tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) and [final-candidate tests](../../src/engine/algorithms/eager-reference/__tests__/final-candidate-review.test.ts) exercise actual step settlement, review binding, replay and atomicity.

Deterministic before/after experiments compare request and committed-state witnesses. Local timing does not establish model accuracy, token savings or production gameplay latency. No model-visible context, state delta, temporal boundary, call count or thinking setting changes.
