# Normalize exact compilation alias ordinals

Artifact-Version: 1
Status: Approved

## Intent

Avoid model repair for a decimal selector's zero padding under the delegated [nonthinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). Recorded outputs used r48 and r86 for existing r048 and r086 directory entries. Their decimal ordinal is unchanged.

## Contract

Before wire-schema validation, alias representations may normalize ASCII r followed by decimal digits to the unique existing padded alias with the same ordinal in the pinned root dictionary. Compare decimal strings without numeric conversion. Unknown ordinals, alternate prefixes, signs, whitespace, fractions and exponents are not recoverable. Canonical candidate keys remain invalid in alias output.

Only reference leaves declared by the actual request schema are eligible. Free text, literal fact values, opaque random-result JSON and undeclared fields retain their bytes and structure. Conditional first/rest and named temporal choices retain their operators. The decoder never invents a missing field, chooses a profile, removes a claim, changes batch size or selects a nearby identifier. Subsequent schema, type, slot, shortlist and semantic validation remain authoritative, including source-state empty-pool constraints.

The provider retains raw output and records each changed path, original and normalized values and root dictionary hash using the existing preprocessing audit. Normalization is idempotent and does not mutate the source value. Canonical decoding still requires exact dictionary membership. A codec version change binds the behavior to new experimental compositions; stopped trials remain immutable.

## Plan

Add a schema-owned lexical preprocessor to the existing codec and wire it into the provider's audited preprocessing boundary. Preserve exact canonical decoding and bump the codec version. Use captured output for a zero-HTTP recovery proof before freezing a new complete-player trial.

## Verification

Exercise actual compiler calls with shortened selectors and prove first-call canonical output equality, preserved source state and raw/normalized audit evidence. Test the full assertion schema, conditional lists, named operators, opaque values, unknown ordinals and a dictionary exceeding three digits. Verify root identity through repair and preserve existing invalid-reference and domain regressions. Run relevant tests and check:fast before a local commit, then freeze a fresh complete-player diagnostic. Offline recovery is not evidence of game success or a speedup.

## Evidence

[Codec tests](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-representation.test.ts) and [real compiler tests](../../src/engine/algorithms/eager-reference/__tests__/represented-action-compiler.test.ts) own the regression. [Postmortem 0113](../postmortems/0113-zero-padding-causes-model-repair.md) records the escaped failure.
