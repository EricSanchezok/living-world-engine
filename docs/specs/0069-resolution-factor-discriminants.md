# Resolution Factor Discriminants

Artifact-Version: 1
Status: Approved

## Intent

Make factor validation failures precise under the [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). Explicit model choices determine which structural alternative is checked; a missing field in a chosen factor must not require interpreting failures from unrelated factor types.

## Contract

The model factor schema dispatches by its existing role and authority literals. The twelve strict alternatives, all legal source kinds, direction choices, step magnitudes, channels and reference constraints remain intact. Unknown or missing discriminants fail explicitly. Neither validation nor repair chooses a direction, substitutes a source, changes authority or removes a factor. The model can revise a discriminant when its intended meaning requires it, subject to the complete schema and source evidence.

The JSON schema expresses mutually exclusive alternatives. Acceptance must match the original nested union over the same strict objects. Diagnostic precision is a foundation correction, not a relaxed success criterion or evidence that the failed plan can commit. The [complete gameplay contract](0067-sparse-canonical-gameplay-candidate.md) still governs fresh trials and budget admission.

## Plan

Revalidate the recorded rejected candidate offline. Compare old and new accepted domains, exercise real gateway repair evidence, then run check:fast and commit locally. Freeze fresh source/body proofs before any subsequent paid trial; preserve all costs and closed failures.

## Verification

Compare accepted values and parsed output across legal and invalid roles, authorities, sources, directions, magnitudes and channels. Verify missing fields and strict unknown-field rejection. The recorded failure shape must yield two exact missing-direction paths while retaining both helpful and hindering as model choices. An authored fact mismatch must still allow either a semantically justified authority revision or an eligible authored source. Keep canonical gameplay validation and replay tests.

## Evidence

[Domain and diagnostic tests](../../src/engine/contracts/__tests__/resolution-factor-discriminants.test.ts), [factor codec tests](../../src/engine/mechanics/__tests__/resolution-factor-types.test.ts), and [gateway tests](../../src/engine/models/__tests__/model-provider.test.ts) own the guardrails. [The incident report](../postmortems/0086-unselected-factor-repair-branches.md) records the failure boundary.
