# Conversation order and report boundaries

Artifact-Version: 1

## Executive summary

A continuous real-model regression completed all 24 planned rounds and passed state replay, but only 11 rounds met the frozen conversational rubric. Coalesced narration could publish an answer before its question, an NPC could finish an inspection without reporting, and expansion admission could repeatedly reject ordinary architectural detail while exceeding the provider context limit. Passing mechanical checks did not establish a coherent conversation.

## Summary

The affected interfaces carried valid facts and references but omitted relationships needed by their consumers: speech order before irreversible publication, the original request when deciding whether an NPC response was complete, and the distinction between independent objects and parts of a described place. The full transcript and costs remain in the [regression record](../research/2026-10-14-conversation-continuity-regressions.md). Quality qualification remains separate from the deterministic guardrails below.

## Timeline

- On 2026-10-14, the first frozen confirmation identified narrative omissions and incomplete compound actions.
- Immediate exchanges were coalesced to give the narrator both the player's words and the reply. A subsequent complete continuous regression exposed reversed speech order and unfulfilled reporting requests.
- Stored provider responses established actual context-limit rejections during expansion admission. The same oversized state was sent during question splitting; content coverage also rejected drafts that described architectural surfaces rather than new portable objects.
- Speech ordering, trigger-bound completion and scoped admission received persistent-host and runtime regressions before another paid cohort was authorized to run.

## Root cause

Speech completeness was checked after streaming paragraphs had become immutable. When a narrator began with an NPC answer, the repair could only append the omitted player question, producing the wrong causal order while retaining every quote. Multiplicity and exact-text checks alone could not detect this presentation error.

An NPC completion question described its current action without the actual interaction it was answering. Observing could therefore count as completion even when the request also required telling the player the result. A later unrelated observation could become the next wake cause after the foreground response had already ended.

Expansion creation and admission received the same global continuity directory, although admission already had a concrete draft and complete local context. Coverage questions additionally repeated inventory and appearance data. Question splitting retained the oversized shared state. Ambiguous object coverage then treated integral surfaces or figurative comparisons as undeclared objects, causing creation and repair work without a committed discovery.

The existing tests established exact speech, valid entities, persisted events and replay. They lacked an irreversible streaming prefix containing a later quote, an inspection followed by an intervening NPC exchange, and an expansion draft with a large unrelated identity directory. These gaps allowed safety checks to pass alongside conversational failure.

## Guardrails

- [Narrative tests](../../src/server/__tests__/world-narrative.test.ts) check exact source speech order before publication, including repeated utterances and immutable prefixes.
- [Persistent host tests](../../src/server/__tests__/direct-world-host.test.ts) exercise inspection followed by reporting through the real saved task queue while another NPC speaks, with replay and the next decision window.
- [Direct runtime tests](../../src/engine/direct/__tests__/runtime.test.ts) retain the complete creation directory while verifying that admission receives draft-relevant identities and the complete local world, with one shared declared inventory and deterministic replay.
- The [frozen qualification protocol](../research/2026-10-14-conversation-continuity-protocol.md) retains failed and missing rounds in its denominator and requires full text and world-state review. Deterministic guardrails cannot substitute for the next complete real-model confirmation and seed repeat.
