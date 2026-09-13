# Component-wide mechanical plan regeneration

Artifact-Version: 1

## Executive summary

A full-world diagnostic exhausted planning recovery after two repairs each regenerated 44 plans. Deterministic errors identified individual plans, but the logical repair responsibility remained the entire component.

## Summary

The failed execution produced no committed world feedback. It demonstrated repeated work and unresolved plan validity, not a successful gameplay latency measurement. Existing semantic-verifier repair was more narrowly scoped, but its existence did not narrow earlier mechanical failures.

## Timeline

1. Initial physical planning generated 49 plans; 14 check plans lacked their required primary effect.
2. The rejected component generated 44 plans in each of two repairs, retaining mechanical failures.
3. Three planning requests generated 54,367 output tokens, with approximately 201 seconds of audited transport time, before the execution rolled back.

## Root cause

Full-candidate validation reports precise plan ordinals, but the generic repair loop requests the same full component. Candidate locality is lost between diagnostic ownership and output responsibility. Accepting partial materialization would create a separate correctness defect because joint constraints still apply.

## Guardrails

[Spec 0113](../specs/0113-scope-mechanical-plan-repairs.md) requires an identity-complete prior candidate, schema-valid retained drafts, exact action coverage, source-bound replacement selection and full reconstruction before joint validation. Real-engine regression evidence must cover both successful local replacement and a replacement that conflicts with an unchanged draft. Production adoption requires prospective experimental evidence under [0029](../specs/0029-nonthinking-gameplay-efficiency-experiment.md).

Full-source offline replay also caught an interaction before a paid comparison: narrowed component replacements and complete singleton recovery were assigned different transport groups solely because their logical scope modes differed. The [batching regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) requires compatible marked replacements to share component recovery transport while preserving their exact logical contexts and all other grouping boundaries. Unknown contracts remain separate.

A subsequent complete-player diagnostic failed a 34-action component after source-index and factor-reference errors. Requiring the entire rejected candidate to pass the schema excluded malformed source selections from scoped repair, and the standard composition did not enable the option. The opt-in contract includes schema-local failures in replacement selection and validates retained drafts with the exact invocation schema. Its frozen diagnostic composition is separately selected; enabling the experiment does not promote it to the standard runtime.
