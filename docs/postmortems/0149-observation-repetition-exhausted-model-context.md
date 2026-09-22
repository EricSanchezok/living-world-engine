# Observation Repetition Exhausted Model Context

Artifact-Version: 1

## Executive summary

Twelve-slot observation requests repeated most action records in several ordered arrays. Four STEP-E3 requests exceeded the model context after reserving output space. The repaired diagnostic producers select the existing lossless observation action dictionary, keeping all slots and evidence.

## Summary

Execution `47516e6c-8da2-40b1-891c-4c9c17bbea22` included a provider rejection reporting 931,471 input tokens plus a 131,072-token output reservation against a 1,048,576-token context. Its serialized context contained 2,982,683 UTF-8 bytes. Exact action interning reduced that recorded context to 1,501,664 bytes, with an identical expanded hash. Byte savings are not a measured token saving or a guarantee about model semantics.

## Timeline

- The B/C incremental foundation emitted shared observation batches with twelve slots.
- Small observer-specific differences kept whole action arrays outside the shared prefix.
- The provider rejected requests before producing usable observations.
- The original request and unknown-usage reservations remained in the experiment ledger.
- An offline probe recovered the exact original context from the compact dictionary.

## Root cause

Whole-array equality factoring cannot reuse individual records across unequal arrays. The repository already had an exact record-and-sequence codec in the sibling integrated diagnostic, but the incremental producer used by STEP-E3 did not select that adapter.

## Guardrails

The [incremental producer](../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm.ts) pins and applies the [existing observation codec](../../src/engine/benchmarks/step-efficiency/observation-action-dictionary.ts); the executable producer inherits the same selection. Both repaired STEP-E3 roots have new versions. The [spec](../specs/0180-executable-interaction-diagnostic.md) retains complete cardinality, observer scope and original output validators.

The [dictionary regressions](../../src/engine/benchmarks/step-efficiency/observation-action-dictionary.test.ts) prove exact order, repeated occurrences, observer-local differences and rejection of altered or unused records. The [incremental host tests](../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm.test.ts) and [executable root tests](../../src/engine/benchmarks/step-efficiency/executable-interaction.test.ts) assert the codec is selected at the real provider boundary while exercising commit, restart, reaction replacement and replay. Live model quality and actual context usage still require separate measurement under the new producer.
