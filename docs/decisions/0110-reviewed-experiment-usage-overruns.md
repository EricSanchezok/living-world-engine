# Reviewed experiment usage overruns

## Status

Accepted
Class: process

## Context and Problem Statement

A provider can return valid usage exceeding an experiment's input reservation estimate. Ordinary settlement stops the transport and preserves the reservation. The response can establish the actual token charge even though the interrupted trial cannot be resumed. Treating this evidence as permanently unknown obscures incurred cost, while silently accepting it would bypass the experiment's stop boundary.

## Decision Drivers

Preserve immutable evidence, accurate account/model pricing, conservative admission limits and the identity of stopped trials. Separate an explicit evidence review from automated request execution.

## Considered Options

- Keep the reservation indefinitely and report actual usage outside the ledger.
- Accept overrun usage automatically and continue the trial.
- Reconcile verified usage explicitly and permanently close the source trial.

## Decision Outcome

The budget journal supports an explicit `reconcile_overrun` entry containing usage, a review reason and an evidence hash. Reconciliation requires all live requests to drain, an unresolved reservation and a real token overrun. It records the entire incurred charge using the reservation's price binding, including a charge that exceeds a monetary limit. The source trial stays permanently closed across reloads. All subsequent admission checks include that charge; a separately frozen trial may proceed only within remaining limits. Ordinary transport settlement still stops on overrun and never performs reconciliation.

## Pros and Cons of the Options

Explicit reconciliation keeps accounting complete without disguising an interrupted experiment as a completed comparison. It requires an evidence review and an additional journal record. Retaining an estimate indefinitely preserves exposure but leaves known usage outside authoritative accounting. Automatic acceptance makes an incorrect reservation estimate invisible to the running experiment and can allow repeated overruns.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Budget implementation](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
- [Overrun, replay and budget regression](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts)
- STEP-E1 evidence and outcomes
