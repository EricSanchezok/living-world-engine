# Intended site was not completed arrival

Artifact-Version: 1

## Executive summary

A player requested rest in a named workroom while physically located in its containing residence. Interpretation produced a wait targeted at the workroom. The wait correctly left placement unchanged, but its attempt and later prose claimed the workroom. A separate required-site binding now catches that inconsistency before frame construction and uses the existing bounded reading repair.

## Summary

The failed invocation `0fdb8c6b-fdfd-48ef-ad79-0b1fa2c4f7ad::rt:model-audit:6873e5906cbd8beaf83e9e7f002d05cc1241c91cc62c2d7e1432dd3e4883d939` occupies Ledger events 16–30. Both the actual residence and distinct workroom were known. Its action selected wait and named the room as target, without a movement frame. Canonical inspection and immutable replay confirmed the actor remained in the residence. No teleportation occurred; the interpretation and prose misrepresented the activity's site.

## Timeline

1. Long-activity live qualification exposed a spatial mismatch alongside a calendar endpoint error.
2. Canonical placement corrected an initial diagnosis that treated the residence and its room as the same place.
3. Full-context paired probes added explicit current-site instructions. They corrected two of three different-place requests while preserving same-place rest and spoken future plans. Prompt-only correction was not stable enough.
4. The action reading gained a separate required-site field and the current place's exact known aliases. A contradictory nonmovement activity entered the existing single consistency repair.
5. Real-entry regressions exercised repaired movement, continuation at the committed destination, repeated inconsistent output, same-place aliases, speech and unknown locations.
6. Follow-up play exposed a coupled repair failure: changing wait to move retained the later phase deadline. Invocation `b25c2847-9ad0-475f-a47d-7810dfe9e786::rt:model-audit:80d82f19b07f21fc07b3996448997a1f6479f786e1cd545efaf57e4f092f13ea` was correctly rejected before a frame committed. The repair instruction now requires dependent fields to describe the same prerequisite, and the current-location identities are supplied beside their keys.
7. Full-context probes found that present-tense wording still sometimes made the interpreter treat the requested site as completed arrival. The reading prompt now distinguishes intent from current-state evidence. Reordering the output fields did not improve the result and was discarded.

## Root cause

An action target can mean a person awaited, an object inspected or a movement destination. The interpretation treated that overloaded field as sufficient to express where a rest happened. The engine had no independent site binding with which to reject a nonmovement action whose words presupposed arrival elsewhere. Narration then inherited the attempted wording as if its site were established. Automatically moving every wait target would have introduced a different authorization error.

## Guardrails

[The execution-site contract](../specs/0201-action-execution-site-binding.md) separates required location from semantic target. [Action reading](../../src/engine/direct/action-reading.ts) validates that an explicitly bound nonmovement site is the actual current place, accepting all exact local aliases. Otherwise it repairs toward a genuinely authorized movement or prerequisite, or asks for clarification. Repeated contradictions commit no action. The mechanism does not infer travel from a wait target, dialogue or a future plan.

[The real-entry tests](../../src/engine/direct/__tests__/activity-site.test.ts) replace only model HTTP and verify placement, time, continuation, rejected-state invariance and replay. A full-context live-model probe correctly handled all nine different-place, same-place and speech trials, using ten physical calls: one initial inconsistent reading was repaired. This is bounded empirical evidence rather than a guarantee against every future semantic misreading; fresh play remains a separate acceptance step.

The subsequent coupled-repair regression rejects a movement that retains an incompatible later calendar deadline. The final prompt layout passed two complete 30-case groups covering the preserved failure context, different-place requests, same-place requests and spoken plans. These groups used 30 and 31 physical model calls respectively; six cases per group supplied the historical rejected reading before exercising the actual repair boundary. An intervening provider-balance failure remains separate service evidence. No additional mandatory model stage, reduced catalog or relaxed consistency check was introduced.
