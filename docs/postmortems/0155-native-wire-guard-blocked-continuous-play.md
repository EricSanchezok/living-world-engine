# Native Wire Guard Blocked Continuous Play

Artifact-Version: 1

## Executive summary

A continuous harbor session stopped producing new results after an eight-turn context exceeded the native profile's 262,144-byte local request guard. No provider request was made for those rejected decisions. The production native wire guard permits 4 MB; actual provider token rejection still controls semantic splitting and fallback.

## Summary

In `narrative-continuous-1791921924740`, harbor turn eight saved a new character and scene before its next decision failed. Turns nine through eleven made no HTTP requests and produced no new paragraphs. World state and saved prose survived, and the independent station session continued. These failed turns remain in the experiment denominator.

## Timeline

- Run `ed2f62e3-8f01-47f5-a217-057c769b5b48` retained `model profile decision-jev request is 278568 bytes; maximum is 262144 bytes`.
- Its last committed discovery belongs to execution `e34c2890-5402-4515-b0e0-c5c7277a7b95`, terminal Ledger sequence 1037.
- The next player request also failed locally at 276,417 bytes, with zero paid requests. It was not a provider context refusal or a failed token reservation.

## Root cause

The direct decision path correctly waited for actual provider context errors before splitting, but an older profile byte guard rejected the rendered request first. Serialized question schemas and UTF-8 text crossed that guard without establishing the provider's token count. Short-flow tests never reached the wire boundary.

## Guardrails

The [native decision tests](../../src/engine/models/__tests__/decision-v2.test.ts) use the production profile ceiling and send a request above 300 KB through the actual gateway with only the paid transport replaced. They retain the separate actual-provider-overflow test. The [continuous driver](../../scripts/experiments/immersive-narrative.ts) preserves failed runs even when no exception reaches the caller. [Narrative measurement](../game-design/narrative.md#evidence-and-measurement) owns the wire and fee boundaries; larger requests remain charged against the same append-only authorization.
