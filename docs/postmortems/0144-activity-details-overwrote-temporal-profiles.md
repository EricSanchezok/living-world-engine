# Activity Details Overwrote Temporal Profiles

Artifact-Version: 1

## Executive summary

Action Compilation assigned an existing Activity's details to its referenced temporal profile. A localized repair then saw the original profile again and correctly rejected the changed pinned candidate. Detail projection must select the record's owning reference rather than infer ownership from the presence of a referenced profile.

## Summary

STEP-E3 executions `50ebf98f-52b7-4be4-9697-3cd06846e23c` and `e86d758b-0fb6-4b45-a122-bb5049bf5685` failed in candidate reuse. Both the executable candidate and ordinary baseline were affected. The source state remained unchanged; the generated context differed between a five-slot request and its single-slot repair.

## Timeline

- The full batch included an actor with an existing Activity.
- Its record carried both activityRef and profileRef; the detail collector preferred profileRef.
- Another actor required a localized repair that excluded that Activity.
- The same profile candidate had different details, so pinned selection stopped before another request.
- A deterministic two-actor compiler regression reproduced the wrong profile payload before the fix.

## Root cause

The projector inferred the identity field by checking several possible reference properties. It treated an Activity's profile relation as ownership and overwrote the script-authored template. The existing repair tests covered slot renumbering and private candidates but had no Activity sharing a published profile.

## Guardrails

The [context projector](../../src/engine/algorithms/eager-reference/action-compilation-context.ts) supplies explicit owning keys for temporal profiles and Activities. The [real compiler regression](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-pinned-selection.test.ts) includes an Activity, repairs only the other actor, verifies authored profile details in both calls and checks source immutability. Pinned state, source and candidate checks remain unchanged.
