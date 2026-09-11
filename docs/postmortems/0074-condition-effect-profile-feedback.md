# Condition Effect Profile Feedback

Artifact-Version: 1

## Executive summary

A complete-world step exhausted planning recovery because four condition effects selected a duration profile as their condition profile. The references resolved as mechanics, but the authored profile family was wrong. The validator rejected the effects with only an opaque plan-level message; the next repair changed unrelated text and retained the invalid selections. No state committed.

## Summary

Reference resolution and effect profile compatibility are separate gates. A condition effect may use an authored condition profile with its required default duration, or an open semantic condition with no authored condition profile and an explicit valid duration. The engine must diagnose these relations without selecting a replacement or deleting an effect.

## Timeline

- The original four-action planning root referenced undeclared new-condition proposal keys.
- The first repair corrected those keys but retained a duration profile in every conditionProfileRef.
- All four effects failed with invalid condition effect at the plan path.
- The second repair changed permission factors, access and descriptions while preserving the same invalid profile pair.
- Recovery exhausted, the step rolled back, and concurrent planning reviews drained without a commit.
- Materializer and real runtime regressions expose the field-specific failure and a successful explicit model-side correction.

## Root cause

The reference catalog provides typed profile handles as well as mechanic aliases. Resolving a mechanic alias establishes identity and permitted reference use, not membership in a specific authored profile family. Canonical validation correctly rejected the mismatch, but discarded the draft field and compatible reference domain. Earlier reference feedback tests covered unavailable handles, grounding and effect targets; none exercised a resolvable profile from the wrong family or an incompatible condition-duration pair.

## Guardrails

The [materializer](../../src/engine/mechanics/truth-engine.ts) reports reference.invalid_effect_profile at the original conditionProfileRef or durationProfileRef field. It retains the rejected value, lists compatible authored handles, explains the nullable open-condition option and collects failures across all three effect channels. Validation changes no action, effect or state. The [inspection regression](../../src/engine/mechanics/__tests__/resolution-plan-inspection.test.ts) checks wrong condition family, wrong duration family, incompatible authored pairing and immutable inputs. The [runtime regression](../../src/engine/mechanics/__tests__/resolution-grounding-feedback.test.ts) checks one repair receives the exact issue, preserves the intended condition effect after an explicit correction, applies it to state and replays the atomic commit. Paid model recovery and effect semantics still require separate source-bound evidence.
