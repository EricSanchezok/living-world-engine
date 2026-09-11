# Action-grounding Repair Ambiguity

Artifact-Version: 1

## Executive summary

Correct action-scoped source rejection produced ambiguous repair feedback, without the action identity, field location or valid choices needed to resolve it.

## Summary

STEP-E1 trajectory 10 compiled all 48 actions on their first attempt, but resolution exhausted repair at Ledger 755/756. A source legal for one action in a component was used by another action whose committed reads and writes did not include it. The diagnostic identified only an opaque plan id and the rejected source. Finding that source in another action's projected dependencies initially suggested an engine identity mismatch; offline materialization established that the rejection belonged to a different plan and was correct.

## Timeline

The first resolution response used sources outside individual action groundings. Bounded repairs ended with another pair of such errors, causing atomic rollback. Offline inspection matched each draft action to its actual committed grounding, and a real-engine regression reproduced the missing repair metadata before the fix.

## Root cause

The engine discarded the draft's action reference, proposal key and source-field position when it raised a generic error. Repair received neither the location nor the action-specific legal source handles, despite the validator having this information. A component's shared context did not make its actions' dependency sets interchangeable.

## Guardrails

The [resolution materializer](../../src/engine/mechanics/truth-engine.ts) reports a structured reference error with the exact plan/means field, action handle, proposal key, rejected handle and admissible source handles for that action. It preserves the existing validator and asks the model to retain meaning; it never substitutes sources or expands a dependency set. [Reference errors](../../src/engine/contracts/model-context.ts) preserve optional field paths through prompt repair projection.

The [regression](../../src/engine/mechanics/__tests__/resolution-grounding-feedback.test.ts) exercises a real loaded world through compilation, resolution repair, transition, atomic commit and replay. An existing entity outside the action's grounding remains rejected, and the following request identifies that precise field while excluding the unrelated entity from its repair choices. Paid model efficacy remains an experiment result, owned by the STEP-E1 report.
