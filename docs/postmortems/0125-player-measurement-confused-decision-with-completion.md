# Player measurement confused a decision boundary with completion

Artifact-Version: 1

## Executive summary

The player diagnostic reported completion when WorldHost returned control for another decision, although the player's Activity remained paused and its goal unanswered. The original report retained `wholeGoalAchieved: false`, and source review rejected the trajectory, but its `completedElapsedMs` field still misrepresented a measurement stop as completed work.

## Summary

The `integrated-player-06` run made 70 new model HTTP calls and committed two world steps. First feedback arrived after 387.523 seconds; measurement ended after 476.420 seconds. The player had asked for inexpensive, safe lodging and received no lodging answer. Canonical time advanced by two seconds; the submitted Activity remained paused. The historical result is preserved, with a separate correction identifying the end time and leaving completed-action latency unknown.

## Timeline

- Instance `d230bd98-97c4-44f3-8994-29b14be03ef4` records the complete run in Ledger sequences 1–1454. The participant action began in execution `51832112-b6db-4adc-b6ea-2ed9f1d82647` and committed revisions 2 and 3 across subsequent execution boundaries.
- WorldRun `ca98282f-fc98-4d86-8b58-be166de0f2e4` ended in `awaiting-decision`; Activity `rt:activity:3eb09c2be81746ea29012a95e0761afa58ea2a6977b2283cd6a1805d2856560b` was `paused`, with a continuing outcome and no predetermined completion time.
- Source review compared the reported completion against these persisted states and found the discrepancy before accepting the candidate.
- A regression through real WorldHost, the loader, engine, persistence and public feedback reproduced the same mismatch. With only the model boundary replaced, the old measurement returned `completed` for a paused Activity. Initial fixtures that lacked the recurring external audience reached the lease budget instead; those results were retained as fixture failures, not claimed as the escaped regression.

## Root cause

`runPlayerFeedbackAction` combined `completed` and `awaiting-decision` WorldRun states, requiring only committed feedback before setting the completion timestamp. Public conversation status describes whether feedback was committed, so its `committed` value could not distinguish a finished Activity from a new decision point. Existing tests covered a one-boundary completed action and an unavailable model; neither exercised continuing or interrupted work.

## Guardrails

The [player measurement](../../scripts/operations/player-feedback-playtest.ts) binds the final feedback Activity to the participant, source revision, original action text and run membership. Only canonical Activity completion populates the completion timestamp. An unfinished decision boundary keeps `awaiting-decision` and a separate measurement end time. A lease stop remains stopped.

The [real WorldHost regression](../../scripts/operations/player-feedback-playtest.test.ts) covers completed work, failure before feedback, a continuing goal Activity stopped by its lease, and a paused Activity requiring another decision. The [integrated diagnostic](../../scripts/experiments/player-integrated-playtest.ts) includes this measurement implementation in its source hash binding and uses protocol version 3; historical preparations and reports are not rewritten. Canonical completion remains only a mechanical observation: the [player acceptance contract](../specs/0122-player-action-efficiency.md) still requires independent source-bound verification of the actual goal and effects.
