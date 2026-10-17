# Empty composer during reply publication

Artifact-Version: 1

## Executive summary

A Participant saw an empty, locked composer while the control orb still reported ongoing simulation. World execution had reached its next decision boundary, but the response was still being generated and checked. Composer admission included pending replies; its progress panel and refresh fallback only followed WorldRun execution. One shared progress projection now keeps the whole turn active until publication completes, with explicit in-frame progress and continued synchronization.

## Summary

The affected instance was `89b24370-2dce-42e1-a2ad-c460c65e33c3`. Its committed action remained intact. Narrative execution `c7a0b03c-d396-459b-9a9b-ccdf88c98a87` failed grounding validation because it added an unsupported description; the following narrative attempt succeeded. The longer publication interval exposed the empty footer. Losing the final event could additionally leave the client locked after the server had completed publication because fallback reads had already stopped.

## Timeline

1. On 2026-10-17 at 02:07:42 UTC, the instance reached its next decision boundary after step 2.
2. Narrative execution `c7a0b03c-d396-459b-9a9b-ccdf88c98a87` recorded model work through Ledger sequences 456–496 and failed at sequence 497, at 02:08:22 UTC. Its error artifact `8a7d9c5f50aaeae245d772260111e4e7543163263fe8f80fab5237eb67db668c` identifies unsupported paragraph content.
3. Narrative execution `0f48f70e-bca5-4e65-8374-937901c7084d` succeeded at 02:08:32 UTC. The saved conversation subsequently reported the turn as committed.
4. A browser regression held only the external narrative transport while using the real action, runtime, persistence, and instance routes. It reproduced the missing progress panel before the fix.

## Root cause

Three client decisions used different definitions of completion. Input stayed suppressed while a conversation turn was running, the footer rendered no progress for an `awaiting-decision` WorldRun, and fallback synchronization stopped when WorldRun execution stopped. A world commit is an internal milestone, while the player-facing turn also includes reply generation, grounding checks, and publication. A partial paragraph does not establish completion.

Existing browser coverage used prompt model responses and an intact event stream. It verified action submission and eventual input restoration without holding the intermediate state where execution had finished and publication had not. It also did not independently drop the completion notification.

## Guardrails

- [The shared progress projection](../../src/app/_components/run-status.ts) drives composer admission, publication progress, and continued instance refresh in [the real play page](../../src/app/_components/instance-experience.tsx).
- [Browser regressions](../../e2e/flows/immersive-game.spec.ts) hold the external model response before any paragraph and after one published paragraph. They verify the stable progress frame, reload while pending, 320 px layout, a missing event stream, one failed refresh, complete text, and restored editing without duplicate submission.
- [The presentation contract](../game-design/presentation.md#participant-会话) defines whole-turn completion and the synchronization fallback.
