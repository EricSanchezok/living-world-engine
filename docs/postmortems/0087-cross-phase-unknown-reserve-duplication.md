# Cross-Phase Unknown Reserve Duplication

Artifact-Version: 1

## Executive summary

The complete-gameplay run admission check added the ledger's global unknown reserve to every candidate phase. A closed probe request therefore consumed apparent trajectory and confirmation capacity in addition to its actual probe allocation.

## Summary

The durable ledger and per-request monetary checks retained correct charges and phase ownership. The separate prospective run check was stricter for the wrong reason, which could falsely block a funded complete run. No provider usage was refunded or silently treated as zero.

## Timeline

- A probe response with uncertain billing retained its complete request ceiling in a closed, quarantined trial.
- Prospective complete-run admission added that global ceiling to the requested phase's known cost.
- Budget reconciliation traced the reservation to its original probe phase and identified duplicate cross-phase exposure.
- A shared run-capacity assertion aligned prospective checks with the ledger's existing phase accounting.

## Root cause

The summary exposed known cost by phase but only a global unknown reserve. The launcher reused the global amount for a phase-local check instead of grouping reservations by their recorded phase. Historical charges and total-budget protection were correct.

## Guardrails

The [budget ledger](../../src/engine/benchmarks/action-compilation/experiment-budget.ts) reports reserved exposure by source phase and asserts complete-run capacity against that group and the global total. [Regression tests](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts) retain quarantined unknown charges, verify replay and read-only admission, reject phase overflow, and reject global overflow even when a candidate phase has capacity. The [gameplay launcher](../../scripts/operations/step-efficiency-playtest.ts) uses this shared assertion with its unchanged full-run cap. Reallocation remains prospective and cannot erase incurred or reserved exposure.
