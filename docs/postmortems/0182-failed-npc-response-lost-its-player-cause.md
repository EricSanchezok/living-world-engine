# Failed NPC response lost its player cause

Artifact-Version: 1

## Executive summary

A deterministic real-Host company-payment regression rejected an NPC's proposed payment because the required approval was absent. The world verdict correctly prevented the transfer and requested continuation, but settlement discarded the NPC's original player cause. The foreground window closed before the account could explain the observed failure. This was a response-scheduling failure, not an unauthorized payment or a failed provider call.

## Summary

The current Night City company account proposed a 12000 payment without the required approval. The semantic verdict rejected that proposal, and the transaction kernel left all balances and facts unchanged. The account received the failure evidence, but its next decision was no longer connected to the participant request. A player could therefore observe no transfer and receive no explanation. The regression substitutes only model HTTP responses; it establishes the scheduling defect, not a real model's ability to interpret the world's approval rule.

## Timeline

- The persistent company-payment regression verified a permitted 6000 transfer, six-unit delivery and duplicate-submission behavior after restart.
- Its rejected-payment case exposed the lost request cause after a failed NPC action, despite a world verdict requesting continuation.
- A focused HTTP-to-Simulation regression reproduced the missing explanation. Settlement retained the cause for failed or blocked responses within the existing no-progress bound.
- Independent review found that differently worded failed speech could reset that bound. Progress now requires successful or partial speech, and a regression confirms that two failed attempts stop without delivering invented speech.

## Root cause

The reaction continuation gate admitted only successful or partial outcomes. A failed or blocked response could therefore retain private evidence without retaining the participant request that made a report relevant. The independent background-goal wake path did not preserve that request and could not keep its foreground window open.

An NPC responding to an actual participant submission retains its cause when world adjudication requests continuation after a failed or blocked outcome, subject to the existing no-progress bound. The subsequent choice still belongs to the NPC and passes normal world adjudication. A second attempt without progress stops. Changing the wording of a failed speech attempt does not count as progress or reset that bound. No player authorization, transaction, state schema or model retry policy changes.

## Guardrails

- The [HTTP-to-Simulation regression](../../src/engine/direct/__tests__/failed-reaction.test.ts) reproduces the lost cause, verifies a delivered explanation from the actor's actual failure evidence, bounds repeated failed attempts and differently expressed failed speech, and respects a world verdict that closes the request.
- The [persistent company-payment regression](../../src/server/__tests__/cyberpunk-company-settlement.test.ts) verifies that the rejected 12000 payment changes no quantity or fact and that the account's later spoken explanation reaches the player. Its successful purchase, six-unit delivery and restart deduplication assertions remain independent.
- [Player authorization regressions](../../src/engine/direct/__tests__/player-authorization.test.ts) retain rejection and physical-failure boundaries. The [runtime reference](../game-design/direct-runtime.md#coherent-player-interpretation) owns the continuation contract.
