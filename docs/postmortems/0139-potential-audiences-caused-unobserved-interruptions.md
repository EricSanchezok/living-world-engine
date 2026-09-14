# Potential Audiences Caused Unobserved Interruptions

Artifact-Version: 1

## Executive summary

A full forty-nine-subject player diagnostic paused an external player's lodging inquiry despite an explicit no-stimulus receipt and no boundary events. Both candidate generation and CanonicalCommitter used possible interaction audiences as interruption evidence. Their agreement admitted the same incorrect state. The player received an unresolved status after 412 seconds and could not complete the action.

## Summary

Execution f9735912-c7be-4d1c-b659-dd3ee1f8dcd7 committed forty-nine continuing outcomes, a 300-second clock advance and no events. Fifteen Activities paused. The external player had no reaction request, external stimulus or observed source event, but its disposition cited relevant_committed_observation. These results describe a failed gameplay diagnostic, not successful latency. Other semantic and performance failures in that run remain independent of this interruption defect.

## Timeline

- The complete diagnostic committed no events and forty-nine continuing outcomes; the player's final onset receipt supplied no stimulus.
- Inspection connected the player's paused disposition to the producer's audience intersection before observation rendering and the matching committer rule.
- A real-entry reproduction failed at both equal and unequal checkpoints under that rule. The corrected producer and committer preserve continuation without external event evidence.
- The player-feedback fixture also depended on conservative audiences. Its interruption case supplies an actual witnessed external event and an explicit no-stimulus onset, while preserving the distinction between paused and completed actions.

## Root cause

The producer settled Activities before observation rendering. It intersected audiences of current action, Timer and Condition dependencies with scheduled observers. That observer list includes ordinary own-outcome coverage, so it establishes neither an external stimulus nor relevance. Removing retained Activity footprints from this rule had left the same inference for current dependency nodes. The committer repeated it; earlier integration fixtures expected interruption from conservative membership even when their only event was a generic clock tick.

## Guardrails

- [The observed-interruption contract](../specs/0165-observed-activity-interruptions.md) keeps onset decisions in preparation and derives later automatic interruptions from witnessed external-action event provenance. Rendering precedes settlement and final review; observation repair recomputes settlement from the immutable base.
- [Real-entry boundary regressions](../../src/engine/algorithms/eager-reference/__tests__/boundary-interruption.test.ts) reproduce the failure at equal and unequal checkpoints, reject a forged pause and preserve retained footprint validation and replay.
- [Accepted observation tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) distinguish self progress, witnessed external events, unobserved events and revoked observation evidence through SimulationEngine and final review.
- [Causal ancestry coverage](../../src/engine/mechanics/__tests__/observed-activity-interruptions.test.ts) verifies event, check, random and mechanic ancestry without deriving a stimulus from clock or fact leaves. The selector establishes interruption eligibility; existing causal and observation validators still own candidate admission.

## Evidence

The pre-fix real-entry reproduction failed both checkpoint cases with expected active and actual paused. Corrected fixtures preserve actual external-event interruption instead of changing every expectation to continuation. Execution contract 11 and new producer identities bind the changed behavior; obsolete compositions are rejected without migrating the source diagnostic.
