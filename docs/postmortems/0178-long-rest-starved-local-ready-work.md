# Long rest starved local ready work

Artifact-Version: 1

## Executive summary

An overnight rest reached its correct calendar endpoint while nearby characters never received another choice after hearing a buyer's offer. The scheduler now admits relevant local work and its actual causal follow-through alongside direct participant reactions while an unfinished participant submission owns the foreground window.

## Summary

Instance `c9156797-35e7-47b2-8f8c-08b0c94e0842` completed three local actions at ten seconds and a buyer's offer at sixty seconds. Immutable replay at revision 3 showed the father, manager and helper ready with the buyer action `rt:action:c6c436e4ff0b15c63c4ec72c19813eac484f1a87f023303b193f960ce390998f` as their cause. Their actual locality checks passed. The next physical boundary was the participant's 32,400-second rest completion, with these intents still ready. Replay matched the recorded state and the Ledger doctor found no index drift.

## Timeline

1. Calendar and activity-site qualification established correct movement and requested dawn/dusk endpoints.
2. Reading the complete trajectory exposed the missing local exchange despite correct final clocks.
3. Historical state inspection isolated ready local actors that the foreground selector excluded.
4. A real-engine regression reproduced the omission with only model HTTP replaced: the seller's response was skipped until the participant's long rest ended.
5. The local window was derived from existing unfinished work, actual locality and causal records. Tests added restart, temporary departure/return, simultaneous participant reactions, unrelated distant actors and repeated unchanged dialogue.

## Root cause

`participantReactionIds` deliberately recognizes direct replies to participant submissions. The scheduler treated that narrow set as the complete set of eligible work whenever a participant had an active submission. It selected no other ready agents and then used the activity deadline as the next clock boundary. An initial local admission path ran only for fresh submissions, leaving authorized step transitions with the same gap. Readiness and time arithmetic were correct; the admission policy was incomplete.

## Guardrails

[The local-work contract](../specs/0202-local-causal-work-during-participant-activities.md) treats long participant activities as concurrent with relevant local affairs. [The derived-window decision](../decisions/0256-derive-local-activity-work-from-existing-causal-records.md) scopes eligibility to unfinished work and current causal intent. It adds neither a global actor sweep for interpretation nor a separate scheduling model call.

[Real-entry tests](../../src/engine/direct/__tests__/local-activity-window.test.ts) verify a committed seller reply before the deadline, an actual departure and return across restart, equal opportunity with direct reactions, distant exclusion, quiescence and immutable replay. Repeated identical dialogue already terminates under the existing no-progress and observation mechanisms; no permanent utterance hash or new speech ban was added. Actual-model play remains necessary to evaluate dialogue quality and latency, beyond deterministic scheduling correctness.
