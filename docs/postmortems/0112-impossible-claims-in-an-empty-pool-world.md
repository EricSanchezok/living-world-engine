# Impossible claims in an empty pool world

Artifact-Version: 1

## Executive summary

A complete-player trial failed during action compilation because a ship Entity was repeatedly selected as a shared resource pool. The world contained no typed pools. Specializing the empty domain in the request schema makes that known constraint explicit before model recovery.

## Summary

The player received no committed world feedback. One NPC's complete action described reconnaissance and preparing ships without authorizing an attack. Compilation repeatedly populated resourcePoolCandidateKey with an Entity key. Typed validation correctly rejected the value, but repeated repairs did not correct it.

## Timeline

- The source world and full compilation catalog contained no shared resource pools.
- The general output schema still allowed nonempty pool claims with any candidate-shaped key.
- A model selected an Entity as a pool through multiple recovery calls.
- Captured source state confirmed that the empty pool domain was real, rather than a retrieval omission.
- The represented adapter was found to regenerate the generic schema instead of preserving the actual compiler request constraints.

## Root cause

The request exposed an output branch with no legal inhabitant in the bound world state. The adapter's schema reconstruction also prevented the common compiler from supplying a stronger state-derived contract. Late validation preserved correctness but wasted calls and ended the step.

## Guardrails

[The domain specialization](../specs/0111-specialize-empty-resource-pool-domain.md) derives empty-list constraints from actual state and carries them through representation adapters. [Real compiler tests](../../src/engine/algorithms/eager-reference/__tests__/represented-action-compiler.test.ts) retain complete actions, source state and valid populated-pool behavior. Schema conformance does not establish semantic correctness or successful gameplay; prospective player testing remains required.
