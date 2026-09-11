# Append Provider Cohorts to One Budget

## Status

Accepted
Class: process

## Context and Problem Statement

A provider can retire a model while keeping its request name routable. Exact response identity validation stops such a trial, even when the response contains complete usage. Continuing on a replacement requires explicit pricing and a fresh comparison cohort while preserving the user's remaining spending limit.

## Decision Drivers

Keep one authoritative budget, preserve raw evidence and unknown reservations, forbid silent model aliases, and separate provider upgrades from algorithm gains.

## Considered Options

- Rewrite the original policy and historical model binding.
- Start another independent budget for the replacement model.
- Append immutable price registrations and reviewed routed-response reconciliation to the existing journal.

## Decision Outcome

The experiment uses append-only model-price registrations and explicit routed-response reconciliation under [the cohort contract](../specs/0097-provider-model-cohort-accounting.md). A replacement selects its exact model and price in new requests. The source trial remains closed and its result is not converted into an algorithm success. Baseline and candidate must share the replacement model to support algorithm comparisons.

## Pros and Cons of the Options

Rewriting the policy obscures what was requested and invalidates historical hashes. An independent budget simplifies model configuration but can duplicate authorization and lose existing exposure. Appending evidence preserves admission and replay in one ledger; it adds explicit reconciliation records and requires a fresh baseline.

## Links

- [Cohort contract](../specs/0097-provider-model-cohort-accounting.md)
- [Provider model retirement and pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [Experiment budget](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
