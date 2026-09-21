# Intention Selection Mutated an In-Flight Compilation Snapshot

Artifact-Version: 1

## Executive summary

A full-world player diagnostic failed when resumed intention selection changed the control-state field of a planning snapshot that another compiler still used. The compiler correctly rejected repair against a different source. Preparation must accumulate control updates separately and publish them after both compilation branches settle.

## Summary

Execution b5974a97-3710-4a44-9b02-5369f2436339 stopped 45.648 seconds after player submission. It produced no feedback and committed no world step. All eighteen physical requests and responses were retained, and canonical state remained unchanged. The proposed planning scheduler was never reached, so this run supplied no scheduling-latency evidence.

## Timeline

- Known action compilation began while resumed Agents were still thinking.
- Resumed cognition returned a program, and intention selection updated the shared planning state's execution document.
- A known-action batch failed validation and requested local repair.
- The compiler's pinned-source hash check detected the mutation before another HTTP request was sent.
- A controlled regression through the registered incremental Composition reproduced the same failure with resumed compilation gated ahead of the known-action repair.

## Root cause

The selection helper assigned each result to both its proposed control-state variable and the shared planning state. The first selection preceded compilation, but the resumed selection ran during known-action compilation. TypeScript's shallow readonly parameter did not prevent the owner from replacing a field. The compiler hashes the complete SimulationState, including private control state, to guard candidate reuse. Existing overlap tests used the ordinary algorithm without the stateful selection hook; the persistent-intention test covered guards and restart but did not combine resumed selection with a delayed known-action repair.

## Guardrails

The [preparation owner](../../src/engine/algorithms/eager-reference/eager-reference.ts) keeps the proposed control state separate during compilation and publishes the final value only after both branches settle. It preserves concurrent resumed compilation, the compiler's hash check and atomic failure. The [registered-composition regression](../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm.test.ts) executes real selection, retrieval, compilation and repair, verifies the enforced completion order, retains both Agents' intent records and checks that source state is unchanged. The same test file owns WorldHost persistence, restart and failed-preparation rollback. [Spec 0177](../specs/0177-persistent-intent-execution.md) owns this lifecycle contract.
