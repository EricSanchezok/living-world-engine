# Independent budget renewal

## Status

Accepted
Class: process

## Context and Problem Statement

A new user spending authorization can arrive while a completed experiment retains conservative historical estimates and unresolved request holds. Rewriting historical charges to match a reported account aggregate would invent per-request billing evidence; simply raising a ceiling would also reuse old unspent funds.

## Decision Drivers

Preserve evidence, honor the exact new spending amount, retain unknown exposure and resume through the existing transport and journal.

## Considered Options

- Replace historical costs with the account aggregate and increase the original policy.
- Start an unrelated ledger and reroute all experiment tools.
- Append a unique authorization with independent future-request accounting.

## Decision Outcome

Use an evidence-bound authorization entry in the existing journal. Future request exposure is limited by both the cumulative authorized ceiling and the latest tranche amount. The new boundary captures prior request identities during replay; later historical refunds cannot expand current spending. Record the account aggregate as user-reported evidence, not invented request settlements.

## Pros and Cons of the Options

Replacing costs loses the original evidence and breaks policy hashes. An unrelated ledger separates funds but fragments tools and request provenance. An append-only tranche retains the shared accounting path and requires explicit summary fields for current versus cumulative exposure. Unused prior funds are not automatically available after renewal.

## Links

- [Change contract](../specs/0080-additional-experiment-budget-tranches.md)
- [Budget journal](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
- [Historical valuation decision](0142-reviewed-account-currency-valuation.md)
