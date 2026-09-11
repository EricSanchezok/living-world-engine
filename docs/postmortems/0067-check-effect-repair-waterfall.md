# Check Effect Repair Waterfall

Artifact-Version: 1

## Executive summary

Two check plans omitted both their primary effect and failure threat. The canonical validator rejected the missing primary effect first. Their next model response supplied a primary effect but retained the missing threat, while unrelated factor errors obscured the still-invalid check. An independent known requirement was withheld from the first repair.

## Summary

The output wire schema already requests both effects, but the hosted JSON interface does not enforce it. Runtime validation must continue rejecting invalid plans and make all known missing check stakes visible together. No outcome, magnitude or resolution mode can be inferred merely to make a plan valid.

## Timeline

- A complete source probe returned two check plans with null primary and threatened effects.
- Materialization rejected each plan with a generic primary-effect error at the plan path.
- The first repair supplied condition primary effects but left threatened effects null.
- Additional schema failures consumed the remaining repair allowance before either check became valid.
- Offline materializer and full-step regressions exposed both missing fields in one repair without changing accepted plans.

## Root cause

The [resolution validator](../../src/engine/mechanics/resolution.ts) checks primary and threatened effects sequentially. Its first thrown error hides the second independent failure. Cross-plan aggregation in Truth cannot recover information that the per-plan validator never returns.

## Guardrails

Check plans with missing or none primary magnitude, missing failure threat, or both raise a typed diagnostic containing every failed check-effect prerequisite at its exact field path. The [prompt issue projector](../../src/engine/contracts/prompts.ts) preserves those paths and original null/none values. The actual [materializer and full-step regressions](../../src/engine/mechanics/__tests__/resolution-plan-inspection.test.ts) verify joint-scope preservation, both diagnostics in the next repair, atomic commit and canonical replay. Automatic no-effect and blocked behavior retain their existing contracts; malformed checks remain rejected. Paid recovery and semantic preservation require separate source-bound evidence.
