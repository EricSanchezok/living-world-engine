# Player interpretation exceeded authorized scope

Artifact-Version: 1

## Executive summary

A player requested a free inspection and consent-bound maintenance. The language interpreter turned a later NPC question into permission to invent a diagnosis, quote a price and promise a completion time. World adjudication correctly determined that those words could be spoken, but never independently checked whether the player had authorized them. The repair adds a typed player-scope decision to the existing complete adjudication batch and rejects an unadmitted candidate before any world event or delivery.

## Summary

Real-model acceptance on 2026-10-17 exposed the failure in instance `8adf41ea-25ac-47c0-bca1-8c04b9f285e8`. The player's request authorized inspection and maintenance within consent; it did not authorize the generated 30-euro price, ten-minute commitment or unsupported diagnosis. The original free-inspection offer remained present in prior requests, participant discourse and the actor's private perspective. An earlier physical receipt established an executed inspection without the claimed diagnostic result. The generated speech nevertheless committed at revision 8, and the NPC answered it at revision 9. A subsequent narrative fallback did not roll back these world events.

## Timeline

1. The first anomalous boundary was `PlayerActionReadingV4`, invocation `fb3f25fe-de7f-4026-b48b-9a75f5b8e07d::rt:model-audit:3d5a3e5112eb63701bc9b4d19bdee685f02aa1cb10f02f56f807dbb1c6b0e653`, Ledger sequences 4299–4368. Input sequence 4300 retained the original request and receipts; parsed output 4366 treated the NPC's question as the current player input and authored the new quote.
2. World invocation `fb3f25fe-de7f-4026-b48b-9a75f5b8e07d::rt:model-audit:2c4855f5f631c2e7b1a26564da122d8061b5065ceb83064987f6bb3704af642d`, sequences 4384–4525, received the candidate at 4385 and accepted speech feasibility at 4523. Its 48 questions had no player-authorization decision.
3. Three entry-path regressions first reproduced the defect: both unknown and out-of-scope player quotes executed, and rejecting only the player was impossible while retaining an independent simultaneous NPC question.
4. The added scope choice, original-submission context and admission handling made those regressions pass. Further coverage exercises a continuation's receipts, native transfers, a permitted follow-up report and a conditional NPC payment without a valid player offer.
5. An isolated production-model comparison retained all 48 original questions, actions, delivered evidence, compressed actor memory and model bindings. The baseline again selected speech success. Both revised trials selected `outside_scope` while retaining `succeeded` for physical speech feasibility. The final trial used 49 questions, one dispatch and no format repair.
6. Follow-up entry tests exposed a second boundary: a later NPC observation or a fired timer changed the retained failed submission back to `ready`. A persistent WorldHost case reproduced this after an authorized initial question, rejected continuation, reconnect and completion of an already admitted NPC reply. The reply remained real; its delivery could not become permission to retry the failed player interpretation.
7. A release-control regression confirmed that the human submission must remain available while admitted physical work can be re-adjudicated. An actual intervening NPC observation changed the evidence dependency; clearing the submission immediately had removed the original authorization from that re-adjudication. The retained reference is cleared once the activity finishes, and subsequent model-controlled choice uses the autonomous reader.

## Root cause

The player reader's existing instructions already prohibited unsolicited speech and treating another character's question as player permission. Those instructions did not prevent this actual model output. Its diagnostic `authorizedSteps` field repeated the mistaken interpretation, so trusting that field would have asked the same producer to certify its own mistake. Executed-branch validation checked catalog references and parameters, not whether the act belonged to the request.

World adjudication conflated two different questions: whether the words could be delivered and whether the human had chosen to say them. Speech must remain capable of carrying false claims when the player actually requests them, so a universal speech-truth check would not repair the authorization defect. The world prompt also described `proposal.rawText` as original input even though expression generation could replace it with a model-authored attempt. The original active submission needed a separately owned place in the world batch.

Tests emphasized literal quotation restoration, valid bindings, resource conservation and recorded replay. They did not send an internally well-formed but unauthorized generated quote through the real interpretation, adjudication and settlement entry. Narration runs after commitment; its agency check cannot serve as admission for an already-delivered action.

A failure flag alone was insufficient. Generic world-event wake paths intentionally made waiting and failed intentions ready again, while the active human submission remained attached. Suppressing only observations in the rejection's own batch left later observations, dependency changes, timers and deadlines able to retry it. The durable boundary is policy-dependent: external control retains the failed submission until new human input; releasing control lets the character choose autonomously while preserving any already admitted activity and its original authorization evidence.

The final revised request used 33,321 input tokens compared with 27,353 for the paired baseline: an increase of 5,968 tokens, approximately 21.8%, from explicit authorization and receipt context. It used 5,819 output tokens compared with 5,737, and took 32.504 seconds compared with 30.881 seconds. Both used one model dispatch; there is no additional per-action model call. Different cache hits and single-sample timing prevent a performance conclusion, and two successful revised classifications do not establish universal semantic reliability.

## Guardrails

- The [direct runtime](../game-design/direct-runtime.md) owns the separate original-input, receipt and delivered-speech contract. Only an authorized candidate reaches settlement; rejection is a recoverable interpretation failure, not a fictional obstruction, substituted act or delivered speech. Same-batch actions cannot use a rejected candidate as consent or payment evidence.
- [Direct entry regressions](../../src/engine/direct/__tests__/runtime.test.ts) run through SimulationEngine and the real model HTTP adapter. They check actual frames, observations, resource changes, retained submissions, concurrent NPC outcomes and replay, with unauthorized and unresolved model answers supplied at the nondeterministic boundary. Separate later-observation and timer cases remain failed without another interpretation call. Release cases check autonomous choice and preserve the authorization context when an admitted activity is re-adjudicated after new evidence.
- [Persistent host regressions](../../src/server/__tests__/direct-world-host.test.ts) check that an interpretation failure stops its run, remains recoverable after reads and reconnect, and requires new player input to execute again. A second case retains an admitted NPC reply across reconnect, commits that reply, and reaches a new decision window without retrying the rejected continuation.
- [Spec 0191](../specs/0191-natural-action-time-and-world-initiative.md) owns player authorization for spending, commitments, risk choices and voluntary dialogue. The independent scope question uses the existing batch rather than adding a mandatory validation round trip or reducing its question set. Private reflection retains its separate private path.
