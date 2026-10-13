# Repeated Evidence Restarted Invalidated Programs

Artifact-Version: 1

## Executive summary

A real station trajectory repeatedly asked for supplies and quoted the same exchange terms without transferring quantities. New testimony identities reset the private planning allowance, and invalidated program versions re-entered the reusable choice domain. Producer `decision-event@6` binds retry eligibility to distinct private information and excludes invalidated or exhausted versions from automatic reuse.

## Summary

The development continuation stopped at revision 34 and world second 17 after its 15-minute execution lease. The three goals remained active and quantities were unchanged. The persisted state replayed identically without model calls. This is an incomplete task, not successful dialogue progress. The [research evidence](../research/2026-10-13-jev-runtime-entry-evidence.md) owns request counts, costs and qualification limits.

## Timeline

- The station's initial programs asked for supplies and proposed terms.
- Jev correctly requested a plan revision when the engineer waited for goods before accepting the offer.
- A newly delivered copy of the offer reset the expansion allowance.
- The selector offered a previously invalidated version because the allowance had reset, allowing alternation between two inadequate programs.
- The bounded continuation exhausted its wall-time lease without a resource transfer.

## Root cause

Planning eligibility hashed evidence identifiers and the growing observation history. Those are valid audit distinctions but do not establish a new course of action. Reuse filtering considered only the currently active program and depended on the transient attempt counter. Ending a program without goal evidence also made it eligible for immediate reactivation.

## Guardrails

The direct runtime supersedes generated plans under [Spec 0182](../specs/0182-jev-direct-world-runtime.md). Its permanent [real-entry regression](../../src/engine/direct/__tests__/runtime.test.ts) checks that repeated actions without progress enter a recoverable wait and make no further model calls. The following frozen links preserve the original repair evidence.

The [planning retry fingerprint](https://github.com/EricSanchezok/living-world-engine/blob/05d273f7/src/engine/programs/planning-input.ts) ignores only clock changes, duplicate evidence identity/step and generated observation-pointer metadata, claim evidence references and duplicate observation revision/step metadata. It retains perceived speaker descriptions, non-observation source identities, terms, belief stance, mechanics and all other private content. This fingerprint controls the bounded expansion allowance only; model input, cache dependencies, scheduler subscriptions and durable evidence remain complete.

The [actual goal domain](https://github.com/EricSanchezok/living-world-engine/blob/05d273f7/src/engine/events/goal-selection.ts) excludes every last invalidated program version and programs that ended without visible progress or goal evidence. Explicit controller interruption permits resumption. The same domain is reconstructed by the canonical validator. [Control regressions](https://github.com/EricSanchezok/living-world-engine/blob/05d273f7/src/engine/events/__tests__/program-control.test.ts), [domain regressions](https://github.com/EricSanchezok/living-world-engine/blob/05d273f7/src/engine/events/__tests__/goal-selection.test.ts) and [fingerprint regressions](https://github.com/EricSanchezok/living-world-engine/blob/05d273f7/src/engine/programs/__tests__/planning-input.test.ts) cover repeated testimony, budget exhaustion, explicit resumption and changed speakers, terms, stance or resources. General live task completion remains subject to separate qualification.
