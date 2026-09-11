# Effect Target Declaration Feedback

Artifact-Version: 1

## Executive summary

A full-world planning component exhausted two repairs because an effect subject was visible in the source catalog but absent from the same plan's declared targets. The generic message described an undeclared entity without identifying either field. The next response changed causal references and retained the rejected relation. The step rolled back without a state commit.

## Summary

An effect target must belong to its plan's target set. This is a relation between two model-selected fields, not a missing world entity. Feedback must locate the effect target, retain its original handle, and identify the plan's currently declared target handles without treating those handles as the complete visible candidate domain. Choosing the subject or adding a target remains a semantic model decision.

## Timeline

- Initial planning selected check mode with missing primary and threatened effects.
- Repair supplied both effects on an existing subject absent from the plan's target list.
- Materialization rejected the plan with a generic undeclared-entity message at the plan path.
- The second repair changed causes but preserved the target mismatch; the component exhausted recovery and the complete step rolled back.
- Offline inspection and runtime repair regressions reproduce the mismatch on existing fixture entities and preserve all offending effect paths together.

## Root cause

The canonical resolution validator owns engine IDs and throws at the first undeclared effect target. The model-facing materializer had no projection of this relational failure back onto draft field paths and reference handles. The entity was resolvable, so ordinary catalog reference checks passed. Existing repair tests covered unavailable references, action grounding and missing check effects but not an existing entity omitted from a plan's declared targets.

## Guardrails

The [materializer](../../src/engine/mechanics/truth-engine.ts) collects `reference.outside_plan_targets` issues across primary, secondary and threatened effects before canonical plan validation. Each issue preserves the effect field path and original reference and explains the relationship to the same draft's target list. The [inspection regression](../../src/engine/mechanics/__tests__/resolution-plan-inspection.test.ts) verifies all three paths, immutable source/candidate data, and admission after an explicit model-side target declaration. The [runtime repair regression](../../src/engine/mechanics/__tests__/resolution-grounding-feedback.test.ts) verifies both invalid effect subjects reach one repair before atomic commit and replay. The canonical validator remains authoritative, and neither feedback nor inspection changes target membership or effect meaning. Paid recovery effectiveness requires separate evidence.
