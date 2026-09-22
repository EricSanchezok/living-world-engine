# Reaction Programs Mutated Frozen Execution State

Artifact-Version: 1

## Executive summary

The executable-interaction diagnostic rewrote its execution journal after reaction compilation. Canonical commit correctly rejected that changed journal. Version 2 keeps replacement programs in the current completion's temporary binding map and returns the frozen preparation state unchanged.

## Summary

STEP-E3 executions `c9a990cc-1683-4613-81ef-bffd7fa035ce` and `91191f37-9754-4b89-b4dd-6a121d81eaec` failed at canonical commit after expensive adjudication. The preparation contained 49 and 45 bindings respectively; the candidates contained 50 and 46. These failures remain part of the original version 1 experiment.

## Timeline

- Initial compilation persisted executable bindings in the preparation.
- Onset perception caused an Agent to replace its action.
- Replacement compilation added a binding in the completion-local map.
- The adapter serialized that map into the candidate execution state.
- The kernel rejected the candidate because it differed from the frozen journal.
- A regression through the registered producer reproduced the exact rejection after restoring a serialized preparation.

## Root cause

The adapter treated preparation and completion as equivalent persistence boundaries. The original integrated test kept all initial actions, so its completion map happened to equal its preparation map. Lower-level stale-binding tests did not exercise the canonical commit boundary with a real replacement.

## Guardrails

The [adapter](../../src/engine/benchmarks/step-efficiency/executable-interaction-algorithm.ts) persists bindings only during preparation. Replacement bindings remain available for the current completion, but cannot alter the frozen journal. A later ongoing replacement without a persisted binding falls back to ordinary adjudication. The [approved contract](../specs/0180-executable-interaction-diagnostic.md) records this lifetime and the new producer version.

The [registered-producer regression](../../src/engine/benchmarks/step-efficiency/executable-interaction.test.ts) runs both keep and replace reactions through preparation serialization, restoration, execution, canonical commit, replay, duplicate-commit rejection and a subsequent step. It asserts exact execution-state equality and verifies that the lie is delivered without changing canonical authenticity. The kernel's frozen-state check remains unchanged.
