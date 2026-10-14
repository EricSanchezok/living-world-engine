# Record explicit aggregate token-limit removal

## Status
Accepted
Class: testing

## Context and Problem Statement

Conservative token reservations interrupted the [continuity regression](../research/2026-10-14-conversation-continuity-regressions.md) despite remaining monetary authorization. The human explicitly requested a complete run without this aggregate token gate under [Spec 0185](../specs/0185-continuity-wrap-up-and-complete-evaluation.md). The original journal must remain reproducible.

## Decision Drivers

- Honor the explicit removal without changing currency authorization.
- Preserve prior holds, usage, failures and the policy hash.
- Keep effective limits inspectable after restart.

## Considered Options

- Raise the static token ceiling and reconstruct the journal under a changed policy.
- Start a new journal without historical token reservations.
- Append a phase-specific token-limit removal to the existing journal.

## Decision Outcome

Use an explicit `remove_token_limit` entry bound to the original phase limit and authorization evidence. Replay retains the original policy and all accounting entries, applying an unbounded aggregate token gate only to the named phase. The summary exposes this as a null effective token limit. Monetary reservation, request counts, unresolved usage and per-request usage ceilings retain their existing checks. No runner removes a limit automatically.

## Pros and Cons of the Options

- Changing the policy requires rewriting or reinterpreting historical evidence.
- A fresh journal separates the run from existing liabilities and obscures cumulative spending.
- An appended authorization preserves the full chain and isolates the intended permission change. It adds one accounting operation that must remain explicit and restart-safe.

## Links

- [Budget implementation](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
- [Budget regressions](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts)
- [Temporary reservation incident](../postmortems/0163-temporary-model-reservations-paused-continuous-play.md)
