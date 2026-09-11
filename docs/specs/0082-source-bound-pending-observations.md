# Source-bound pending observations

Artifact-Version: 1
Status: Approved

## Intent

Provide an experimental observation algorithm that renders an unchanged world's uncompleted activity directly from trusted source identity and lifecycle. Arbitrary action prose remains an attempt; a narrative result is not evidence that an event occurred.

## Contract

Register a distinct opt-in observation-rendering identity. Retain the model renderer for all cases outside a conservative deterministic admission predicate. The default Composition is unchanged.

Direct projection requires one positive advance_time operation, no events or decision requests, and exact equality of canonical truth except elapsed time and activities. The observer must own exactly one supplied action and continuing outcome without known alternatives. Exactly one matching active activity must preserve the complete source action, have no completed progress or stages, and have its next boundary strictly after the candidate clock. The source activity's boundary, or the first scheduled checkpoint of a newly admitted activity, must also remain strictly ahead: advancing a due activity's next boundary cannot hide a checkpoint inside this interval. Any observer repair feedback disables projection. No semantic interpretation of action words, outcome summaries, or predicates participates in admission.

The packet quotes the complete original action as an intention and reports only that the owner's activity remains active and the world's elapsed interval. It introduces no entities or apparent claims, asserts no completed sub-action, and says nothing about unobserved third parties. This is a deliberately limited progress update, not a claim that every possible perception has been enumerated. Existing reaction stimuli, receipts, actions and temporal state remain intact. Every packet still uses the existing materializer, information boundary, observation validator and final candidate review.

Direct projection makes no model request and fabricates no model audit or usage. Other slots retain their complete model context, batching and repair limits. Experiment reports must distinguish direct projections, model observations, unknown source semantics and missing perceptual detail. A deterministic packet is not proof that the upstream action resolution was correct.

## Plan

Implement the predicate and packet through the existing renderer, register the candidate, verify fallback at changed-world and semantic-repair boundaries, then replay the actual failed snapshot without network. Freeze the candidate before paid gameplay. Full trajectory and independent confirmation remain required before promotion.

## Verification

Exercise the real ObservationRenderer using loaded world state. Verify exact owner/source binding, original prose retention, zero calls for eligible progress, model dispatch for facts/events/due boundaries/repair, and preservation of packet validation. Check full-world historical applicability separately from measured runtime cost or semantic success. Run focused tests and check:fast before commit.

## Evidence

The [renderer](../../src/engine/cognition/observation-renderer.ts), [regression tests](../../src/engine/cognition/__tests__/observation-renderer.test.ts) and [registered candidate](../../src/engine/algorithms/registry.ts) own this contract. The [offline preflight](../../scripts/experiments/step-pending-observation-preflight.ts) binds historical evidence without preserving synthetic model observations. The [decision](../decisions/0145-project-pending-activity-observations.md) records its scope and tradeoffs.
