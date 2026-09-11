# Record prospective experiment phase allocations in the existing ledger

## Status
Accepted
Class: process

## Context and Problem Statement

An autonomous experiment can exhaust one phase's reserve while other phases retain money within the same user-authorized total. Continuing with a revised allocation must preserve historical costs and uncertainty, and must not create a second apparent spending balance.

## Decision Drivers

- Keep the original total authorization and immutable account/model prices.
- Preserve every incurred charge, unknown reservation and closed-trial restriction.
- Make changed phase limits explicit and reproducible before future requests.

## Considered Options

- Rewrite the original policy or old ledger records.
- Open a separate continuation wallet and subtract a parent balance.
- Append a prospective phase-allocation record to the existing ledger.

## Decision Outcome

The budget ledger accepts an evidence-bound `reallocate_phases` record between experiments. Its hash chain retains the base policy identity, original prices and every request. Replay applies allocations in order. The effective allocation and its hash appear in the budget summary. All covered phases remain represented exactly once, their total cannot exceed the authorized ceiling, and known plus fully reserved charges must fit every new group. Active or unreviewed unknown requests prevent the change.

This mechanism does not authorize a larger budget, modify generation settings, reset counters, refund uncertainty or reopen a quarantined trial. A caller must prospectively record its actual allocation and use the existing single-writer discipline.

## Pros and Cons of the Options

### Rewrite the original policy

- Requires little new machinery.
- Breaks historical replay and obscures which limit applied when a request was dispatched.

### Create another wallet

- Separates continuation accounting.
- Needs a permanent parent seal and aggregate admission checks to prevent both wallets spending the same remaining money.

### Append an allocation record

- Keeps one balance and preserves the original chain and charges.
- Adds a journal event and requires reports to distinguish the base policy from the effective phase allocation.

## Links

- [Authorized experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Budget ledger](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
- [Allocation and unknown-billing regressions](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts)
