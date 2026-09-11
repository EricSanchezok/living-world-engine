# Repair Suggestions Escaped the Action Shortlist

Artifact-Version: 1

## Executive summary

Action compilation repair diagnostics advertised references that the same request's shortlist validator would reject. Preserving the original candidate selection did not automatically scope the resolver's suggested alternatives.

## Summary

STEP-E2 `probes-e2-source-owned-03` passed its five frozen diagnostic batches with three localized repairs. HTTP 002 repaired an Agent reference used as a state dependency. Its issue listed 1,719 alternative keys, including 1,417 outside that action's visible shortlist. The repair succeeded without widening the accepted set; this run does not establish an extra failed call caused by the suggestions. The contradictory guidance and unnecessary request content were observable defects.

## Timeline

Code `9256d3f` executed the probe. Source 2's first logical invocation, `rt:model-audit:c19d8720ae1f4366df7f9728a9048f6162bee9a459c69bceaa452636df334414`, rejected one slot with `reference.disallowed_use`. The next HTTP request contained full-resolver alternatives in its localized issue. The execution record indexes the original request and `v2/runs/probes-e2-source-owned-03/analysis.json` with exact counts and costs.

## Root cause

Reference exceptions enumerate alternatives from the full canonical resolver. The compiler converted those handles to candidate keys but did not intersect them with the failed action's selected set. Alias reservation then made the unselected keys syntactically plausible in the repair namespace. Existing shortlist membership and root-pinning tests checked the catalog and output acceptance, while omitting diagnostic suggestions. The same path was reachable after both domain validation and localized schema recovery.

## Guardrails

The [compiler](../../src/engine/algorithms/eager-reference/action-compiler.ts) intersects suggested alternatives with the original action's selected keys after handle conversion. It retains the invalid value, error reason and previous output as diagnostic evidence. The [production repair regressions](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-pinned-selection.test.ts) exercise domain rejection and schema localization, verify per-slot visible membership, retain legal suggestions, and confirm that repair does not rerank candidates. This does not infer semantic suitability from membership.
