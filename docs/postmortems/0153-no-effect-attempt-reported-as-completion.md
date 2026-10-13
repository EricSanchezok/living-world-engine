# No-effect Attempt Reported as Completion

Artifact-Version: 1

## Executive summary

A continuous station session reported a pressure test as completed even though the persisted pressure property remained untested. The physical attempt produced no effects, but its generic completion receipt entered the actor's memory and was reused by dialogue creation. The receipt now distinguishes an attempted operation from a confirmed state change.

## Summary

The retained trial `narrative-continuous-1791915836923` completed eleven station turns with valid replay, yet turn eleven falsely reported a finished pressure test. World resources and pressure remained mechanically consistent. Player-facing meaning was wrong. The preceding repair also produced a second attempt and repeated prose without consuming materials twice.

## Timeline

- Exploration introduced a persistent test panel beside the existing machine.
- Action selection chose the panel as the affected object instead of the instrument, so the pressure property was absent from its effect candidates.
- Execution `6318f787-f499-4075-abb0-7be90cd684d7` admitted an operation with no effects; its world decision spans Ledger sequences 4358–4371.
- The receipt described completion, and a later generated report treated the attempted test as finished despite the observed untested property.
- Full text review against saved state exposed the mismatch; replay and resource checks alone did not.

## Root cause

Feasibility and committed effect were conflated in the default outcome summary. Dialogue creation received accumulated attempted-action evidence without an explicit current-property projection. Generic target selection also failed to distinguish the object affected from its control instrument. Conditional physical requests could reach adjudication as unresolved conditions instead of concrete attempts using known procedures. Existing deterministic tests covered applied effects and blocked transactions, but did not assert the meaning of a feasible physical attempt with an empty effect list.

The related trial `narrative-regression-1791919379834` exposed the inverse ambiguity: a second actor actually reused a learned method, but narration claimed that actor had not moved. Execution `d6a07b6c-1051-4b4c-a005-4f5a14cf1218` committed the method; narrative invocation `c27cfa95-5a57-4ace-8b24-970e1aab5723::rt:model-audit:153cd5c15c8cf4de1b299079d1a847a865ecee8ff789b8af13a827453294332d` spans sequences 571–589. The generic receipt omitted both the method in prose and actor attribution in the witness's memory. Reused physical methods receive an explicit performed-method receipt, and witness evidence names the actor through the observer's local alias.

## Guardrails

The [runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) require a no-effect attempt to retain a partial outcome, unchanged facts, a wait and replay equality. They verify concrete expression before a new physical operation and report creation from observed properties without another actor's private truth. The [activity regressions](../../src/engine/direct/__tests__/activities.test.ts) preserve ongoing work and learned capability reuse without regenerating the method. The [runtime contract](../game-design/direct-runtime.md) owns receipt semantics. The [continuous experiment](../../scripts/experiments/immersive-narrative.ts) retains full text and canonical state; semantic review remains necessary because a model can misinterpret even well-formed evidence.
