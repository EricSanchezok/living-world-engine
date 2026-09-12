# Self Condition Generation Reference

Artifact-Version: 1
Status: Approved

## Intent

Remove a redundant spelling dependency when a generated resolution effect creates its own Condition, within the complete-player objective in [0122](0122-player-action-efficiency.md).

## Contract

The separately configured benchmark representation accepts explicit `conditionRef: null` on a condition effect as a reference to that effect's explicit proposalKey. Decoding supplies exactly `{proposalKey: effect.proposalKey}`. Existing Condition handles and explicit proposal references remain representable without modification, including references to another declaration. An incorrect explicit reference stays incorrect; the adapter cannot infer spelling, identity, target, effect magnitude or intention from prose. Missing or malformed declaration keys remain failures under the original validators.

Only primary, secondary and threatened condition effects inside current commit_plans envelopes are transformed. Repair context, historical candidates, unrelated nested objects and all non-condition effects remain untouched. The adapter retains the original schema and preprocessor chain, binds the complete context, generated schema and instructions, and preserves independently valid neighboring slots and rejected output evidence. Both system and contract tail describe the same generation rule. Source data, action cardinality, target domains, semantic validators, model and disabled thinking remain unchanged. This adapter is not registered in the gameplay composition.

## Plan

Implement and verify the adapter through the actual gateway and coordinator. Replay the complete recorded initial 49-action request and the two 47-action repair requests with zero HTTP; accepted historical outputs must round trip exactly and malformed explicit references must remain rejected. Record any intentional source reconstruction drift after the interval-settlement contract change. Freeze two ordered blocks, B/C then C/B, on the same complete initial source before four paid calls. Use one initial response per cell, no repair, continuation, resampling or world execution, one transport attempt and a 240-second request bound.

## Verification

Cover existing, self and cross-declaration references, all three effect roles, Unicode and malformed keys, non-condition effects, unrelated historical objects, valid neighbors, physical output rejection and request mutation. Run focused tests and check:fast before committing and dispatching. Report actual use of the new null form, condition/effect counts, original-gateway acceptance, source semantics, output volume, tokens, cache and transport separately. The small ordered screen cannot establish reliability or causal latency improvement; full-player qualification requires the original complete-world criteria.

## Evidence

[Decision 0188](../decisions/0188-use-explicit-null-for-self-condition-reference.md) owns the representation alternatives and transfer boundary from intermediate-representation research.
