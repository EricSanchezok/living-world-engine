# Inspection evidence and intermediate effects

Artifact-Version: 1

## Executive summary

Live Fanren qualification exposed two semantic gaps after resource ownership tests passed: target quantities did not become inspection evidence, and a short lift-and-return method left its intermediate levitation state active. A request to inspect and report stopped before the report.

## Summary

Instance `6eb46754-cc72-4235-8a21-e334877fd8fb` contained seventeen crates at the shop and three elsewhere. The player's inspection revealed the stock entity but no count. Reading the receipt revealed its claimed twenty crates. The interpreter waited with an explicitly authorized report still outstanding. A later spell debited one mana but left `levitation_control=true` although its own method ended with the object back in hand.

## Timeline

1. Import and origin tests established real inventory, reciprocal relationships and separate accounts.
2. Live play committed inspection and manipulation actions without transport errors.
3. Ledger inspection confirmed the missing count, the interpreter's premature wait, and the capability declaration's persistent intermediate effect.
4. Target measurement was added to the existing world batch; actor-only evidence now uses settled quantities. Interpretation and capability contracts explicitly distinguish post-step progress and final physical state.

## Root cause

The perception path projected quantities only for personal inventory and committed transfers. A stock holder's presence was visible, but its measured resources had no observation route. The interpreter correctly avoided inventing a number, then treated obtainable evidence as a reason to stop the compound request. The capability creator confused a method's intermediate force with its final condition. Mechanical commit faithfully executed that incorrect declaration.

## Guardrails

- [Simulation-entry tests](../../src/engine/direct/__tests__/runtime.test.ts) check measured, concealed, zero and uninspected quantities, witness isolation, unchanged resource state and replay. A separate case checks a real meter cost without a lasting qualitative effect.
- [The inspection contract](../specs/0196-quantity-inspection-and-final-action-state.md) owns the access boundary; [decision 0250](../decisions/0250-actor-scoped-quantity-inspection.md) records the choice over duplicate inventory facts.
- Player interpretation judges continuation after the selected observation. Capability declarations represent the final stage, with numeric costs independent of lasting effects.
- [Live qualification](../../worlds/fanren/authoring/validation/followup-live-runs.json) retains failures. Prompt changes and deterministic transport replacements alone do not establish real-model semantic success.

## Evidence

The private Ledger passed integrity checks with 9 executions, 657 events and 37 invocations. Player reading `bc03508b-70c7-4c8b-aa7b-6a4ac281625f::rt:model-audit:085a610088b3d20db3a8138c88b7d903bc0dbe3d387e8d708ddb80fd528b535d`, sequences 211–261, recorded remaining inspection/report steps but selected `wait`. Capability `2114f981-30f6-4f57-9530-3da88d411f78::rt:model-audit:968772dc235e75838fc842652c496c0e388ae73fd02f45015284abb11518b535`, sequences 442–455, declared persistent levitation alongside final placement with the actor.
