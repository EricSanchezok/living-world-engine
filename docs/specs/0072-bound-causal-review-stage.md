# Bound Causal Review Stage

Artifact-Version: 1
Status: Approved

## Intent

Separate the existing causal review operation from transition generation so final-candidate orchestration can use the same reviewer without an extra critic. This is a prerequisite to correcting post-review observation replacement under the [non-thinking gameplay contract](0029-nonthinking-gameplay-efficiency-experiment.md).

## Contract

The review stage captures its complete evidence before asynchronous model work. Accepted and rejected reports identify that immutable evidence and the prompt version. A caller can accept the report for a candidate only if its evidence still matches and the report accepts. Changed observation text, state, rules, reactions, effects or other supplied evidence invalidates the binding; matching actor IDs or summaries alone is insufficient. The binding is a program-owned identity check, not proof that the model's semantic judgment is correct.

The same stage serves existing transition resolution and future final-candidate orchestration. It retains current context construction, materialization, model role/profile, format repair limits, cancellation, invocation identity and audit ownership. The current caller keeps its transition and observation repair loops and committed random results. No new provider request, prompt change, omitted context or alternative reviewer is part of this extraction.

This unit does not yet relocate global observation generation or apply a final-commit coverage gate. The full gameplay objective remains unmet until final-candidate integration and real-world verification pass.

## Plan

Extract the existing causal call into a reusable TruthEngine stage, route the current caller through it, and attach immutable evidence bindings. Verify that in-flight caller mutations cannot change what a retry reviews or relabel an accepted result. Run focused and full checks before a local commit; keep paid trials stopped during this preparatory unit.

## Verification

Exercise the real stage with a substituted expensive provider boundary. Verify accepted and rejected results, exact evidence matching, changes to observations/state/rules, mutation while a request is in flight, and unchanged single-call delivery. Existing TruthEngine and step tests must retain repair behavior, outcome/effect checks and canonical replay.

## Evidence

[Stage tests](../../src/engine/mechanics/__tests__/causal-review-stage.test.ts) own evidence immutability and binding checks. [Step tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) retain gameplay entry-path coverage, including [actual reaction delivery](0071-causal-review-reaction-evidence.md).
