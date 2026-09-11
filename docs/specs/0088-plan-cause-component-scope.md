# Plan cause component scope

Artifact-Version: 1
Status: Approved

## Intent

Bind indexed cause choices to the same action domain enforced by the TruthEngine, including during targeted repair. The continuing autonomous optimization authorization covers this repair of the experimental interface; it adds no budget or semantic approval.

## Contract

The indexed cause configuration requests a task.planCauseScope containing the exact action references in the current TruthEngine allowedForCommitments.action set. It comes from the owning component closure, not from the full visible catalog or the current repair output subset. The same root action domain remains available during targeted repair. Existing complete state and candidate visibility are unchanged.

The cause codec requires this binding and intersects action catalog candidates with it. Every bound action must resolve in that slot's cause-authorized catalog; missing, duplicate or inconsistent bindings fail preparation. Event, fact and law candidates retain their existing domains and canonical checks. The code neither adds nor selects a cause. Each plan must still explicitly cite its own action. The v2 cause contract replaces v1 for fresh experimental configurations; closed records are not migrated or rerun.

## Plan

Expose the exact runtime set through the existing prompt builder, retain it across repair, update indexed cause admission, and reproduce the out-of-component rejection through the real materializer. Verify the optional configuration and complete request reconstruction before another paid trial.

## Verification

Verify visible but out-of-component actions stay in context while disappearing from legal cause choices, same-component peer causes survive targeted repair, and missing/mismatched scope bindings fail. Exercise real game-entry routing and the existing materializer; run focused checks and check:fast before a local commit. Do not reclassify previous catalog-only checks as full causal validation.

## Evidence

The [TruthEngine](../../src/engine/mechanics/truth-engine.ts) owns allowedForCommitments; the [context builder](../../src/engine/contracts/prompts.ts) projects it. [Decision 0151](../decisions/0151-bind-plan-causes-to-component-scope.md) records why assignment-only filtering is insufficient.
