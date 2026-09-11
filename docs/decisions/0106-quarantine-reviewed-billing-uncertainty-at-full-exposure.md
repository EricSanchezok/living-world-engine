# Quarantine Reviewed Billing Uncertainty at Full Exposure

## Status

Accepted
Class: architecture

## Context and Problem Statement

A provider error can omit usage without proving that the request was free. Blocking every later experiment until an invoice is available preserves accounting but can prevent independent work despite a budget large enough to cover the unknown request's entire cost ceiling. Inventing zero usage or dropping the reservation would misstate both evidence and exposure.

## Decision Drivers

- Keep unknown billing visible and fully funded.
- Prevent silent retries of an invalidated trial.
- Permit explicitly reviewed independent experiments within the same budget.
- Preserve journal replay and default fail-closed behavior.

## Considered Options

- Block all experiments until exact billing arrives.
- Assume provider validation errors are free.
- Explicitly quarantine reviewed uncertainty at its full reservation ceiling.

## Decision Outcome

Use an explicit quarantine journal event carrying a response evidence hash and review reason after all live requests drain. Quarantine permanently closes the source trial. Its unresolved request retains the full input/output token and monetary reservation in all phase and global limits. New trials can use only the remaining budget. Exact usage may be settled later without reopening the source trial.

Quarantine is never an automatic error handler. Unreviewed unknown requests still stop new sends; existing runners retain their stricter unresolved-request checks. The STEP-E1 runner recognizes reviewed quarantine, reports the unknown reservation and binds the treatment to its protocol manifest.

## Pros and Cons of the Options

Waiting for an invoice gives exact reconciliation but can prevent unrelated work whose worst-case exposure is funded. Assuming zero billing offers progress by manufacturing evidence and is rejected. Quarantine preserves uncertainty and worst-case exposure while requiring a deliberate review and a distinct trial; its conservative hold can underuse the available budget until billing is reconciled.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Durable budget and replay tests](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts)
