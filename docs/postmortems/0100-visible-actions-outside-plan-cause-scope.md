# Visible actions outside the plan cause scope

Artifact-Version: 1

## Executive summary

An indexed plan selected a catalog-visible action belonging to another Truth component. Catalog and schema checks accepted the reference, but the actual plan materializer rejected it. The experimental cause domain now binds to the same component action set as the runtime.

## Summary

A complete forty-eight-action diagnostic passed the representation checks. Reconstructing its original source snapshot and running the production materializer validated twenty-two of twenty-three slots. The remaining slot referenced an action outside its allowedForCommitments.action set. The catalog advertises possible uses across the full visible workset; it does not encode every stage-specific admissibility rule. Treating its cause permission as sufficient exposed an illegal choice.

## Timeline

- Indexed plans passed catalog and schema checks.
- Replaying the original state through the production materializer rejected a foreign action cause.
- The runtime scope was traced through initial planning and targeted repair.
- An explicit component binding and permanent regression were added.

## Root cause

Catalog visibility and current output assignment each express a different domain from runtime causal admissibility.

Targeted repair further narrows assigned output actions while preserving the component's full commitment domain. Filtering by the current assignment would introduce another error by dropping legitimate peer causes.

## Guardrails

The [scope contract](../specs/0088-plan-cause-component-scope.md) projects the owning runtime set into each resolution source context. The indexed codec requires the binding and excludes foreign action choices while preserving full context. Missing, duplicate, unresolved and owner-inconsistent bindings fail before transport. Existing materialization and semantic checks remain authoritative.

The [codec tests](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) cover visible foreign actions and retained peers; the [runtime test](../../src/engine/mechanics/__tests__/truth-candidate-stage.test.ts) reaches actual targeted repair with unchanged root scope. The [registered game-entry test](../../scripts/operations/step-plan-cause-choices.test.ts) exercises opt-in routing.

## Limits

This fixes admissibility, not semantic relevance. A separate diagnostic selected a population fact to support a price description. No affected diagnostic qualifies as successful gameplay, and previous catalog-only results remain historical evidence with their original limits.
