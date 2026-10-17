# Current authorization was confused with historical discourse

Artifact-Version: 1

## Executive summary

A player explicitly requested a local equipment playback, but world adjudication rejected the first playback step as outside the player's scope. The complete current input was present. Its attached discourse also contained the previous request, and the model treated that historical request as the current authorization. The world projection separates the immutable input fields from the complete historical discourse and names the current `rawText` as the authorization source. The independent scope decision and its rejection boundary remain intact.

## Summary

Real-model manual play on 2026-10-17 reached a completed conversation before the player requested a new physical task. In instance `3d018631-4560-42cb-ac5b-a8efeff7aaf6`, submission `c737895f-84d6-43b7-ac13-8fd89a24d605` asked to connect a working master to stage equipment, play a local excerpt, listen, record the actual result and ask the band members for their impressions. The generated first step connected and played the excerpt with the player's quoted introduction. It did not select a new price, commitment or publication permission.

The scope answer was `outside_scope`. The same response selected physical feasibility as `succeeded`; the engine correctly gave scope admission priority and did not execute the rejected candidate. Revision 4 contained only independent NPC dialogue and a 30-second time advance. No playback result or report entry was committed. This was a semantic interpretation failure, not exhausted credit, a transport timeout or a shutdown artifact.

## Timeline

- Ledger doctor found a fresh index and no missing or orphaned evidence. Lookup resolved execution `de649fca-9786-41e5-a8c8-066262752f73` and public invocation `de649fca-9786-41e5-a8c8-066262752f73::rt:model-audit:78e94351a9587a3c9c40a2e54c97aaf85467d7ee6bb4d4f85a70aa0494915b31`.
- Serialized context at sequence 5767 contained all 203 questions, the candidate, the actual new input, and the previous conversation nested inside that input's `discourse`. Parsed output at sequence 5808 answered `a0_player_authorization=outside_scope`; provider completion was recorded at 5810. The single successful transport took 78,561 ms, used 67,236 input and 16,222 output tokens, including 14,535 reasoning tokens, and had no retry.
- Inspection of the preserved provider response identified the source confusion: its diagnostic attribution described the previous request to ask about motives and expenses as the current player's request. The actual new playback request remained present later in `originalSubmission.rawText`.
- Six deterministic HTTP-to-simulation regressions reproduced the ambiguous input structure before the fix. The revised projection passes those regressions while preserving the full historical context and the original submitted object. Their scripted semantic answers verify evidence transport and commit behavior; they do not establish a real model's classification accuracy.

## Root cause

The authorization context used the entire `ExternalActionInput` as `originalSubmission`. That object includes both the current command fields and a large `ParticipantDiscourse` describing previous published exchanges. Stable serialization placed `discourse` before `rawText`. The instructions pointed to `originalSubmission` as a whole, without distinguishing the current command from historical `exchanges[].requested` entries. Those entries were legitimate reference material, but their nesting made them easy to misattribute as the request being authorized.

The first anomalous result is the model's source selection, not a missing current input or a kernel bypass. The recorded diagnostic attribution supports the layout-confusion explanation; it does not establish that every false rejection has this cause. Existing tests covered unauthorized generated quotes, continued requests, receipt ownership and later wake suppression. They did not send a new physical instruction together with a contradictory previous request in the same current-submission wrapper.

The correction follows the existing player-agency contract. `originalSubmission` contains the unchanged current command fields; `referenceDiscourse` contains the unchanged complete attached discourse. The scope task compares the candidate with `originalSubmission.rawText` and its other current input fields, using historical content only to resolve references selected by that input. A first or next step need not complete a compound request at once. Historical permission cannot override a new restriction, and explicit current authorization does not establish physical success. No world facts, questions, history or semantic branch are removed. There is no new model call or persistent field; the execution producer identifies the changed projection and prompt.

## Guardrails

- The [world preparation entry](../../src/engine/direct/world.ts) binds the current actor and submission before constructing the separated authorization sources. Recombining the two projected parts reproduces the original input. The active submission remains unchanged for continuation and re-adjudication.
- The [authorization prompt](../../src/engine/prompts/user/direct-player-authorization.md) names the current command source and the historical reference role. The same complete world batch still decides scope, feasibility, effects and perception. It cannot substitute a smaller unauthorized action after rejecting the candidate.
- The [permanent entry regressions](../../src/engine/direct/__tests__/player-authorization.test.ts) use the real Gateway, native and language-model HTTP adapters, DirectDecisions, world preparation, settlement and replay. They check current-versus-historical source ownership, an actual admitted property change, rejection of historical promises and excess payment, unresolved authorization, and failure of an authorized but physically unsuccessful act.
- The [existing runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) retain independent same-batch NPC outcomes, continuation receipts, explicit false speech, failed-submission wake suppression and control-release behavior. The [direct runtime reference](../game-design/direct-runtime.md) owns the current contract. Offline scripted responses establish those mechanical boundaries; real-model qualification and latency claims require separately recorded targeted evidence.
