# New participant work skipped a pending remote response

Artifact-Version: 1

## Executive summary

A complete-world playtest let a new participant wait advance the clock past an already requested remote task. The manager was ready and causally linked to the participant's earlier request, but the new-submission path admitted only nearby additional actors. Canonical time and replay were correct while the requested work was omitted. A separate narrative error converted the 1,800-second wait into half of an authored two-hour unit; publication correctly rejected it and fell back to factual text. Neither result qualified natural play.

## Summary

Instance `cdd50c5f-ca46-485c-a920-93ecfcbd5039` retained a request to count stock and report back after the manager reached the stockroom. Run `6c867526-e991-4be5-a641-2d70400c3d50` submitted a silent wait at revision 7. Revision 8 advanced from 900 to 2,700 seconds with the manager's ready intention unchanged. The run used seven HTTP POSTs and 153,387 input plus 24,268 output tokens. It preserved quantities and replay, but neither established a count nor a report.

The preceding trial had exhausted its harness dispatch budget; that diagnostic remained separate from an NPC refusal. Offline execution of the manager's real choice path reached the provider boundary, ruling out same-input suppression as this omission's cause. The continuation's narrative contained supported tea-service evidence but an incorrect traditional time unit and unsupported lamp details. Its rejection was not evidence that established tea objects were forbidden.

## Timeline

1. The complete package and all nine identity initializations passed their local checks.
2. A Flash trial reached the manager's actual stockroom placement before its dispatch budget stopped further work.
3. A new wait completed without selecting that ready remote manager. The final narrative exhausted its bounded repair and published a factual fallback.
4. Offline replay through the real preparation boundary reproduced the omitted actor: foreground membership was true and local opportunity was false.
5. A persistent engine regression isolated an already requested remote return, a new long wait and an unrelated distant actor. The repair retains established eligible work in the new-submission path.
6. Narrative evidence supplies every authored elapsed-unit equivalent above one second, including fractional counts. Generation and repair preserve each count with its own unit while the publication checks retain their existing authority.

## Root cause

The scheduler computed the correct causal response set, then gave fresh participant input priority. After interpreting that input, its additional-actor filter used only local opportunity. This discarded the already computed response set precisely when an earlier request had taken its actor to another place. Existing local-window cases covered continuing a pending activity, but not a new submission arriving while remote follow-through remained ready.

The narrative projection listed unit equivalents only up to the first unit larger than the interval. For 1,800 seconds this supplied hours but omitted the authored two-hour unit. The generator reused the half-hour fraction with a different unit, and repair preserved that phrase. Complete elapsed seconds were present, so the check correctly rejected the contradiction. The projection and prompt needed clearer paired arithmetic evidence; weakening the check would have published a false duration.

## Guardrails

[Local-activity regressions](../../src/engine/direct/__tests__/local-activity-window.test.ts) exercise pending remote follow-through across a new participant submission, restart, clock settlement and replay while excluding unrelated distant readiness. The scheduler retains the existing causal/local eligible set and adds new local opportunities in the same selection pass; it adds no scheduling-model call and does not force an NPC's choice. [Spec 0203](../specs/0203-local-causal-work-during-participant-activities.md) owns that contract.

[Narrative regressions](../../src/server/__tests__/world-narrative.test.ts) verify exact short-wait conversions across different authored units and preserve current object evidence, older prose, the six publication checks and bounded repair through the real gateway. [The narrative contract](../game-design/narrative.md#speech-premises-and-elapsed-scale) separates arithmetic duration, established surroundings and observed events. A correct timestamp, an unchanged replay or safe fallback remains insufficient to establish natural gameplay.
