# Service cap hidden behind failed feedback and distant time jumps

Artifact-Version: 1

## Executive summary

A browser play session received generic incomplete-response text for ordinary follow-up questions. The shared experiment journal had reached its 10,000-request safety cap. This was a service-cap failure, not a semantic rejection of the player's words. Automatic continuation then advanced the world from 11 seconds to distant deadlines, eventually displaying 30 hours. Typed service pauses and absolute interactive horizons now have persistent-host and runtime regression coverage; natural discourse quality remains subject to its separate qualification protocol.

## Summary

The user could not tell why a request failed or whether the world had understood it. A nearby NPC's earlier reply also used an unintroduced definite reference. That presentation defect and the service interruption appeared together, but had distinct mechanisms. The latter blocked both clarification and ordinary speech while the interface reported an undifferentiated failure. Existing committed events remained present, yet later automatic clock work produced an inappropriate reading experience.

## Timeline

- On 2026-10-14 the user supplied the continuous play transcript and requested a general improvement, including intelligible recovery and stable world time.
- Durable invocation evidence identified the request cap at exactly 10,000 sends. The saved timeline recorded 11 → 36,000 → 64,800 → 108,000 seconds.
- Before runtime changes, a continuous evaluation corpus and independent acceptance protocol were frozen under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md).
- A separately authorized grant received explicit additional request capacity without resetting historical charges or unknown reservations. Typed failure propagation, durable service pauses and autonomous time limits were then implemented.

## Root cause

Budget grants carried currency authorization while the request counter retained its older ceiling. The cap was protective, but its cause was not represented in the interaction contract. Provider wrappers carried only a generic failed task into the UI. Narration could also retry after a service cap even though another paid request could not succeed.

The host treated empty participant input as permission to continue scheduling. The direct runtime retained unfinished participant markers after an idle policy, and the next global timer remained a valid earliest boundary even when it was many hours away. Per-run wall-clock and commit leases constrained computational work, not the amount of fictional time such a boundary could advance.

Existing tests checked local failures, replay and individual time barriers. They did not combine a shared cap, participant timeout, saved feedback and restart; passing those tests therefore did not establish conversational recovery or appropriate interactive horizons.

## Guardrails

- [Budget contract tests](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts) retain append-only grants and explicit bounded request capacity. Currency authorization never silently resets counters.
- [Service classification tests](../../src/engine/models/__tests__/service-failure.test.ts) follow typed causes through provider wrappers and reject classification from arbitrary prose.
- [Persistent host regressions](../../src/server/__tests__/direct-world-host.test.ts) exercise decision and narration caps through the real gateway boundary, saved status, paused reply clocks, restart, unchanged effects and deliberate recovery.
- [Direct runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) distinguish bounded idle advancement, nearby due events, explicit long waits and observer simulation, with deterministic replay.
- The [continuous qualification protocol](../research/2026-10-14-conversation-continuity-protocol.md) evaluates introduced references, natural follow-ups and recovery separately from state safety. A typed service fix does not by itself qualify narrative quality.
