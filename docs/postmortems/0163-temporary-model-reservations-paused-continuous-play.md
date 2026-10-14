# Temporary model reservations paused continuous play

Artifact-Version: 1

## Executive summary

A frozen conversation-continuity run paused six steps before HTTP dispatch at the shared token ceiling. The live transport treated an admission shortage as terminal even when settling an active request could make the next request fit. The correction waits for an active reservation to settle, then repeats the same admission checks. Historical holds, spending grants, token ceilings and request ceilings remain unchanged. The correction has local regression coverage; a subsequent paid confirmation has not established recovery of the full cohort.

## Summary

The [retained regression](../research/2026-10-14-conversation-continuity-regressions.md) records 48 started steps out of 72: 42 completed, six paused, and 24 later steps were not run. The first pause reported `ExperimentBudgetError: phase token reserve does not fit` before the provider transport. This was not a provider context rejection or evidence that the monetary grant was exhausted. One interrupted exchange had already committed payment and delivery, so treating the entire attempt as absent would also misrepresent the world.

## Timeline

1. Producer `1cffd2f3` ran the frozen 12-flow cohort against the existing cumulative budget journal.
2. Blackmarsh completed 36 steps; station flows encountered six admission failures and stopped their dependent continuations.
3. Ledger invocation lookup, error events and the preserved budget journal located the rejection in local reservation admission before HTTP dispatch.
4. At the end of the run, token headroom was 7,795,639: enough for one minimum native reservation of 4,065,536, but not two. Historical reservations remained charged.
5. Deterministic transport tests reproduced the concurrent shortage and exercised settlement, streaming, cancellation, stop conditions and unresolved usage.

## Root cause

The budget correctly combines known usage with conservative reserved usage. Native decision output has a zero monetary unit price but still consumes the configured token reservation ceiling. Long-lived historical holds made the distinction between actual final usage and temporary in-flight reservation material to dispatch. The transport immediately propagated every reservation failure without distinguishing requests whose reservations could still settle in the current process from historical holds that it could not release.

Prior tests verified single-request admission, settlement and hard limits, but did not exercise two simultaneous sends when only one conservative reservation fit. Streaming also requires capacity to remain occupied until terminal usage is accounted, not merely until response headers arrive. Request-count and unresolved-usage failures do not become safe simply because another request finishes.

## Guardrails

- [Live transport](../../src/engine/benchmarks/jev/live-budget.ts) tracks only reservations attached to active sends. A token or spending shortage may wait for their settlement; waiting creates no reservation or HTTP request and rechecks the original admission rules before dispatch.
- [Budget transport tests](../../src/engine/benchmarks/jev/live-budget.test.ts) cover temporary token and monetary shortages, permanent historical holds, unknown usage, queued cancellation, experiment stops, and stream terminal accounting. They assert unchanged ceilings and request counts.
- [Narrative measurement contract](../game-design/narrative.md) preserves all historical holds and separates queued admission from permanent exhaustion. A full paid cohort remains required to establish end-to-end recovery; this guardrail does not resolve the separately recorded semantic and narrative failures.
