# Active reply admitted unrelated Agents

Artifact-Version: 1

## Executive summary

A real-model Night City opening activated distant characters while the player was waiting for local replies. The host correctly retained the response window, but the engine treated an empty ready-response set as permission to select every ready model Agent. The fix keeps active responses inside the participant-work guard.

## Summary

The player's speech completed before an independently busy listener finished its current activity. That listener retained the delivered question and an active participant cause. With no ready response at the next boundary and no unfinished player submission, selection fell through to unrelated initial Agent decisions. The affected local tests were paused with their execution evidence preserved; no test was accepted from the interrupted runs.

## Timeline

- On 2026-10-17, twelve-origin acceptance began against the real HTTP and model gateway paths.
- The company opening reached world time 60 seconds and then issued decisions for distant characters while a local response was active.
- A simulation-entry regression reproduced the unnecessary selection: advancing the busy listener made three unrelated model calls in addition to the pending activity reassessment.
- The foreground-work guard was extended to active responses; the same regression settles the admitted activity without selecting another Agent, then delivers its reply.

## Root cause

`participantReactionIds` classified ready and active responses consistently for the host. Engine selection filtered that set to ready actors, but its fallback guard checked only external submissions. These two independently reasonable checks lost the active-only case. Existing tests covered a long player activity and a busy listener separately; the busy-listener fixture lacked a third unrelated ready actor, so global selection was indistinguishable from selecting nobody.

## Guardrails

- [Simulation-entry regression](../../src/engine/direct/__tests__/runtime.test.ts): “settles an active participant reply without starting unrelated ready agents” combines a completed player action, an active listener and a distant ready actor. It verifies no private Agent decisions at the intermediate boundary, the later response cause and exact history replay.
- [Runtime contract](../game-design/direct-runtime.md) retains the shared causal classification required by [decision 0232](../decisions/0232-participant-replies-and-background-conversation.md).
