# Truth actor projection lost binding relations

Artifact-Version: 1

## Executive summary

Truth context exposed local names and bound canonical entities as separate inventories while discarding the relation between them. Two different binding maps could therefore produce identical model inputs.

## Summary

Source review of a mechanically admitted full-world planning probe found an action targeting Greenton while its source actor and action concerned Strangeholms. This prompted an audit of the Truth actor projection. The deterministic reproduction establishes projection information loss; it does not establish that this loss caused that particular model response or that downstream semantic review would accept it. The probe stopped before review or canonical commit.

## Timeline

- The source execution was `3e8bc6ea-e5b2-46b4-8bab-5c66fc2cea78`, instance `4140b64c-b980-4c7d-9737-205fb55224e4`, Ledger sequences 139–760. Its first physical planning context is event 569.
- Prospective `action-frames-01` sample `2-C` passed all eleven planning components but selected the unrelated location. Its complete source and candidate are retained in local experiment evidence.
- A regression through `buildTruthContext` swapped two bindings, preserved canonical inventory order and identical labels, and observed identical actor projections before the fix.
- Model context version 17 and execution producer version 19 preserve issued reference pairs. The source-contract regression and private-projection checks cover the corrected boundary.

## Root cause

`projectModelActors` applied `Object.values` and flattened the canonical lists, removing their local keys. The local inventory was sorted separately, so a positional join was neither represented nor valid. Reference validation could establish that each handle existed, but could not reconstruct which local name it represented. Existing projection tests checked canonical reference vocabulary and private-state isolation without checking preservation of relations.

## Guardrails

The [Truth actor regression](../../src/engine/prompts/truth-actor-bindings.test.ts) exercises the real context builder with identical labels, swapped bindings, unresolved references and multiple canonical targets, and verifies that the private AgentMind projection does not expose the mapping. The [Truth runtime contract](../game-design/engine-runtime.md#truth-与随机承诺) defines its authority. Full model and gameplay acceptance remains governed by the [player action efficiency spec](../specs/0122-player-action-efficiency.md); preserving input information does not certify semantic generation or latency.
