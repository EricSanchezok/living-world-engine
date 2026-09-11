# Explicit Required Outcome Assertion

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), address the twenty-one empty mandatory outcome assertion lists observed in the complete forty-three-action [0050](0050-transition-evidence-worklist.md) diagnostic. Preserve the failed trial and distinguish source coverage from accepted slots and actual world progress.

## Contract

Replace only the indexed outcome wire representation of the canonical nonempty assertions list with required firstAssertion and additionalAssertions fields. The former carries exactly the first original assertion; the latter carries every remaining assertion in order, including an explicitly empty remainder. Both fields remain model-authored. The inverse restores the original nonempty list without choosing a predicate, inserting a clock witness, changing an expected value or removing any assertion. Preserve all assertion variants, references, output meanings, operations, other category schemas and the original canonical validator. Reject conflicting canonical and wire fields; missing or malformed fields cannot become a valid empty list. Keep invalid canonical neighbors isolated where source identity and regrouping remain valid.

The worklist and full shared source context remain unchanged apart from the codec version fingerprint. This representation does not make an irrelevant or trivially true predicate evidence of goal completion. Outcomes, state changes and checkpoint semantics still need independent review and the existing runtime gates. No reasoning-mode change or reduction of actions, context or references is permitted.

## Plan

Replace the unpromoted indexed codec with the new version and verify its inverse and actual gateway behavior. Freeze a new complete twelve-slot, forty-three-action source diagnostic with the shared [launcher](../../scripts/experiments/step-transition-worklist-probe.ts), original disabled-thinking Flash parameters, at most one physical structural repair and two HTTP, no transport retry or redraw. Known usage and complete canonical coverage only permit source semantic review. Earlier failed trials remain closed. Reserve the whole request ceiling against the existing STEP-E2 budget and stop on uncertainty. Do not change the default gameplay Composition before independent source review and a separately frozen full-world trial.

## Verification

Round-trip multiple typed assertions with exact order and reference identities, reject missing first or remainder fields, null assertions, conflicting legacy lists and malformed remainders. Verify an invalid outcome field cannot erase a valid neighboring slot through the real coordinator and gateway. Bind the original source and verify the complete request reaches a blocked offline HTTP boundary. Run focused tests and check:fast before the local commit and paid freeze.

## Evidence

The local STEP-E2 worklist-01 report, raw response and canonical validation evidence retain all forty-three outputs and twenty-one minItems failures. The [codec regressions](../../src/engine/mechanics/__tests__/source-indexed-transition.test.ts) and [gateway recovery tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) establish representation properties, not model semantic reliability or continuous gameplay.
