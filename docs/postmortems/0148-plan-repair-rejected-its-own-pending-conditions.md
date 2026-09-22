# Plan Repair Rejected Its Own Pending Conditions

Artifact-Version: 1

## Executive summary

Targeted plan repair received condition references from its prior candidate plan, but its materializer resolved only conditions already present in canonical truth. A repair can now retain its own pending effect identity without admitting that pending effect as evidence.

## Summary

STEP-E3 execution `f031d17d-83a6-4e7a-bc40-6fd41283fa6f` rejected five repair slots with `reference.unknown_handle`. Each rejected reference was published in that slot's context and matched its own prior action, target and effect channel. The expensive repair loop could not accept these otherwise valid references.

## Timeline

- Initial plans proposed new conditions and materialized their candidate identities.
- Semantic review selected plans for targeted repair.
- Repair context published the selected and neighboring candidate plans and effect handles.
- The model retained its own plan's condition handle.
- The materializer rebuilt a resolver from source truth alone and rejected that handle.
- A complete engine regression reproduced the same unknown-reference failure before commit.

## Root cause

Prompt projection and effect materialization used different identity domains. Globally admitting all published pending references would make the repair succeed, but could also let uncommitted effects justify means, factors or other actions. Requiring a fresh proposal would unnecessarily replace the valid identity already published by the engine.

## Guardrails

The [materializer](../../src/engine/mechanics/truth-engine.ts) receives only the selected prior plan during targeted repair. A condition effect may retain that plan's pending condition when its action, subject and channel agree. The ordinary evidence resolver is unchanged. Another plan's pending condition, a changed subject or channel, and pending conditions used as evidence remain invalid.

The [real repair regression](../../src/engine/mechanics/__tests__/resolution-plan-repair-condition.test.ts) covers successful identity retention through canonical commit and replay, plus five invalid ownership/evidence cases with atomic rollback. Existing condition creation, materialization and mechanical replacement tests remain in force. The [runtime contract](../game-design/engine-runtime.md) and model context explain that a published plan effect is not an established world fact.
