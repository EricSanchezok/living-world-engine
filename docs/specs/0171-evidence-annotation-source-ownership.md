# Evidence Annotation Source Ownership

Artifact-Version: 1
Status: Approved

## Intent

Separate reusable evidence explanations from exclusive mechanical contributions in the [complete-player experiment](0122-player-action-efficiency.md). A source can support both a permission explanation and a risk explanation without contributing twice to a roll or effect. This changes the adjudication contract explicitly; it is not an automatic repair of rejected plans.

## Contract

Permission and risk factors are evidence annotations. Each remains neutral and zero-step, preserves its exact source, authority, channel and explanation, and requires valid existing evidence. A plan may contain one annotation per source and role. The same source may support both annotation roles and one independently justified mechanical assignment. Repeating the same annotation role for a source is invalid, even with a different explanation or authority.

Actor aptitude, difficulty, control, potency, protection and secondary-effect authorization retain exclusive mechanical source ownership within each plan. Secondary is zero-step but authorizes an independently sourced weaker effect and remains mechanical. A source cannot increase a primary effect and authorize its secondary effect, or contribute simultaneously to aptitude, difficulty and another mechanical factor. Existing numeric bounds, source authority, effect ownership, action scope, time, randomness and independent semantic review remain authoritative.

The kernel retains every factor verbatim; it does not choose roles, invent alternative sources, merge explanations, deduplicate accepted output or convert factors into other fields. Numeric derivation continues to consume only its existing mechanical inputs. Receipt application retains the complete set of cited Condition sources and consumes each finite-use Condition once per receipt. Original visibility filtering, Agent receipt explanations, Inspector evidence, causality and replay retain all annotations. Numerical equality alone is insufficient evidence of lifecycle or cognitive equivalence.

World execution contract 12 and Truth resolution contract 5 identify the new semantics. New compositions use those contracts directly, without a compatibility mode or an alternate production validator. Existing frozen experiments remain historical evidence under their recorded producers. This contract replaces the all-factor source uniqueness assumption for permission and risk; [Spec 0064](0064-resolution-source-role-diagnostic.md) remains the record of its separately frozen diagnostic.

## Plan

Update the single kernel validator and the shared model-facing ownership instruction. Retain the original factor schema and all downstream values. Exercise the real resolution, receipt application, cognitive projection and replay paths with controlled model boundaries, then run the required checks and commit the independently verified unit. Preserve old rejected responses for explicitly labeled counterfactual interpretation before any new prospective calls.

## Verification

Verify permission plus risk, annotations alongside aptitude or difficulty, and annotations alongside a secondary source. Reject repeated annotation roles, numeric annotation fields, invalid evidence, duplicate mechanical contributions and conflicting secondary sources. Compare derived checks and effects with the same mechanical plan without added annotations. Through real receipt application, cover finite-use Conditions with one and multiple remaining uses, repeated citations across means and factors, visibility and exact explanation retention, atomic commit and replay. Verify contract pins and run check:fast before a producer commit or paid experiment. This contract change is not evidence of a completed player action or the sixty-second objective.

## Evidence

[Decision 0217](../decisions/0217-separate-evidence-annotations-from-mechanical-contributions.md) owns the alternatives. [Resolution validation tests](../../src/engine/mechanics/__tests__/resolution.test.ts), [receipt pipeline tests](../../src/engine/mechanics/__tests__/resolution-pipeline.test.ts) and [Agent receipt tests](../../src/engine/runtime/__tests__/agent-resolution-receipt.test.ts) own executable behavior.
