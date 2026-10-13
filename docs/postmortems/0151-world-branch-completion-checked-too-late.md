# World Branch Completion Checked Too Late

Artifact-Version: 1

## Executive summary

The frozen full-world B canary admitted a generated ongoing activity with a successful branch that lacked its required completion predicate. Canonical settlement correctly rejected it, but compilation had missed the opportunity for the permitted targeted repair. Producer `decision-event@7` applies the same branch requirements during compilation and settlement.

## Summary

The second and third natural-language inputs in the first B canary failed with `an ongoing activity needs its declared completion predicate before it can finish`. World time remained zero and the final state replayed identically without model calls. The [qualification evidence](../research/2026-10-13-jev-engine-qualification.md) owns the frozen producer and accounting; later fixes do not change those results.

## Timeline

- Generation selected an ongoing temporal profile and a successful branch.
- Compilation validated timing, resource claims and materializable effects.
- The branch reached world adjudication without a valid completion guard.
- Canonical materialization rejected the successful outcome and committed no effects.
- The shared branch contract moved into compilation's existing one-repair loop while remaining enforced at settlement.

## Root cause

The completion and observed-acknowledgement checks lived inside selected-branch materialization. The compiler's branch-shape pass did not call that boundary, and branches involving randomness could not materialize effects before a committed draw. Structural completion and delivery requirements do not require a draw or branch selection.

## Guardrails

The [shared branch contract](../../src/engine/events/adjudication.ts) validates every generated branch before admission: an ongoing successful branch requires its declared completion predicate to be yes, and observed acknowledgement requires a committed observation delivery to the actor. The [compiler](../../src/engine/events/compiler.ts) routes rejection through one targeted repair; the [kernel](../../src/engine/events/kernel.ts) independently validates the selected branch during settlement and replay.

The [real-entry regressions](../../src/engine/events/__tests__/branch-admission.test.ts) replace only remote model HTTP and cover corrected output, exhausted repair, unchanged truth on failed admission, valid execution and offline replay for both contract failures. Existing [ongoing activity tests](../../src/engine/events/__tests__/ongoing.test.ts) retain resumable checkpoints and condition-bound completion. Live game quality remains unqualified until independently measured.
