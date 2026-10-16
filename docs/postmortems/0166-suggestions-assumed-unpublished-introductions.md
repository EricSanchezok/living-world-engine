# Suggestions assumed unpublished introductions

Artifact-Version: 1

## Executive summary

An opening suggestion named Merry Legs although the published arrival had not introduced it. The character's authorized location description included the name, and the suggestion generator treated all authorized knowledge as shared conversational context. The same request spent nearly ten seconds generating three short actions with reasoning enabled.

## Summary

Instance `f97caf09-1e53-4762-8016-eff76f7dccc6` published its arrival before execution `1517f742-c189-4adf-a433-18215ae879f1` produced suggestions. Invocation `rt:model-audit:867e0d326f2ad0e577e3d9de8c2f60ee32bace1b546cac99422f01ffa8124fbf` spans Ledger events 452–465. Its request contains Merry Legs in the self-location and known-location descriptions but not in the arrival. The audit records 9,980 ms transport execution, zero queue wait, 1,251 input tokens, 1,215 output tokens and 1,162 reasoning tokens.

## Timeline

- Independent suggestion generation used the complete authorized perspective and ran automatically at entry and completed turns.
- A real player reported delayed suggestions and a destination absent from the text they had read.
- Ledger request and usage evidence separated the model delay from UI animation and located the unpublished name in the supplied context.
- The approved replacement makes requests explicit, limits scene context to published prose and disables reasoning on the bound creation model.
- Live replacement testing exposed a second assumption: an unexecuted suggestion to find lodging became a specific inn in the next batch. The prompt now explicitly treats previous suggestions as avoidance-only data and requires discovery wording for unknown targets.

## Root cause

Cognitive authorization and conversational introduction are different boundaries. Tests excluded another subject's hidden cognition but allowed every description known to the controlled character, so they did not detect names arriving through otherwise authorized prose. Automatic scheduling also reused a general creation profile's reasoning settings without considering the short, optional task's actual token usage.

## Guardrails

- [Suggestion integration tests](../../src/server/__tests__/suggestions.test.ts) load real Blackmarsh, exclude unintroduced location descriptions and mechanical labels, and inspect actual wire inference and durable evidence. They also verify that entry, turns, reads and restart never invoke the model without a request.
- [Gateway coverage](../../src/engine/models/__tests__/model-provider.test.ts) validates task overrides against the pinned model and records effective settings without mutating the catalog.
- [Browser flow](../../e2e/flows/immersive-game.spec.ts) verifies explicit generation, editable drafts, replacement, failure retention and refresh reuse.
- [The presentation contract](../game-design/presentation.md#情境行动建议) separates published scene facts from character intent and defines one request-driven lifecycle.
