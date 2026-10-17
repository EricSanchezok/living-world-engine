# Active reply admitted unrelated Agents

Artifact-Version: 1

## Executive summary

A real-model Night City opening exposed two busy-listener failures. An active-only reply admitted distant characters, and a listener already answering an NPC lost the foreground cause of a later player request. The fixes share causal classification between host and engine and retain delivered causes separately from admitted work.

## Summary

The player's speech completed before an independently busy listener finished its current activity. That listener retained the delivered question and an active participant cause. With no ready response at the next boundary and no unfinished player submission, selection fell through to unrelated initial Agent decisions. The affected local tests were paused with their execution evidence preserved; no test was accepted from the interrupted runs.

## Timeline

- On 2026-10-17, twelve-origin acceptance began against the real HTTP and model gateway paths.
- The company opening reached world time 60 seconds and then issued decisions for distant characters while a local response was active.
- A simulation-entry regression reproduced the unnecessary selection: advancing the busy listener made three unrelated model calls in addition to the pending activity reassessment.
- The foreground-work guard was extended to active responses; the same regression settles the admitted activity without selecting another Agent, then delivers its reply.
- A later rebased live run delivered a company payment request while the account was speaking in response to an older NPC message. The run opened the next player window with no quantity transfer. The old and new causes were both present in durable action and observation evidence, but only the old cause survived in the intention.
- A persistent WorldHost regression reproduced the missing handover through two actual player submissions. Keeping pending causes separately preserves the old activity, waits for the new request's fulfillment, and commits the requested resource transfer once.

## Root cause

`participantReactionIds` classified ready and active responses consistently for the host. Engine selection filtered that set to ready actors, but its fallback guard checked only external submissions. These two independently reasonable checks lost the active-only case. Existing tests covered a long player activity and a busy listener separately; the busy-listener fixture lacked a third unrelated ready actor, so global selection was indistinguishable from selecting nobody.

The busy-listener guard stored a new interaction only when the active intention's single cause was null. An already caused NPC activity therefore discarded a subsequent player cause even though perception delivered the request correctly. Simply replacing that cause would let the next observation overwrite it and would lose the current work's explicit continuation. The intention needs separate selected and pending causes, with both visible to foreground classification. Pending causes are model work; external control retains observations as evidence without accumulating a stale autonomous queue.

## Guardrails

- [Simulation-entry regression](../../src/engine/direct/__tests__/runtime.test.ts): “settles an active participant reply without starting unrelated ready agents” combines a completed player action, an active listener and a distant ready actor. It verifies no private Agent decisions at the intermediate boundary, the later response cause and exact history replay.
- [Persistent host regression](../../src/server/__tests__/direct-world-host.test.ts): “keeps a new player request foreground while its listener finishes an older NPC-caused activity” checks two player submissions, the older activity's unchanged cause, the queued player cause, a later same-batch background remark, actual conserved inventory transfer, resumption from the busy revision, external-control queue clearing and exact history replay.
- [Runtime contract](../game-design/direct-runtime.md) retains the shared causal classification required by [decision 0232](../decisions/0232-participant-replies-and-background-conversation.md).
