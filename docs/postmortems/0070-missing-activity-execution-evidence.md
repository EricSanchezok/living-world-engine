# Missing Activity Execution Evidence

Artifact-Version: 1

## Executive summary

A repaired plan substituted injury for a luring objective while the simulated interval advanced only ten seconds. Inspection found that planning received an activity description and nullable completion time but not its profile, next checkpoint or progress. Plan verification received no current temporal boundary. The unsupported effect is observed; the causal contribution of missing temporal input remains an experimental hypothesis.

## Summary

An open-ended activity with a later checkpoint is not equivalent to completed work. Models cannot reconstruct an engine's chosen temporal profile or current progress from description alone. The same omission in generation and review can weaken their independence on timing mistakes.

## Timeline

- A bounded historical-response recovery probe added source-bound rejected candidates.
- Repair supplied effects for two malformed check plans but did not recover complete admission.
- Source review identified invented injury in a plan whose action described preparation and later luring.
- The source activity had goal mode, a later checkpoint and no fixed completion time; the model-facing activity record omitted that information.
- Inspection also found raw runtime IDs in due-boundary lists and a missing boundary in plan review.
- An opt-in projection exposed the same factual temporal state and joinable references to planning and both review stages.

## Root cause

[Canonical Truth projection](../../src/engine/contracts/prompts.ts) intentionally exposed a small activity summary. No separate projection supplied execution facts needed for interval-sensitive adjudication. The plan-review context lacked an interval input entirely. More repair attempts or correct JSON cannot establish faithful timing when those facts are absent.

## Guardrails

[Spec 0038](../specs/0038-activity-temporal-evidence.md) owns the opt-in evidence and promotion contract. [Projection tests](../../src/engine/contracts/__tests__/activity-temporal-evidence.test.ts) exercise the real loader and temporal materializer, distinguish checkpoints from completion, and preserve scheduling state and progress. [Admission tests](../../src/engine/benchmarks/step-efficiency/resolution-admission.test.ts) verify generation, repair and plan review share the same source evidence. Source-bound model comparisons must still assess intent, unsupported effects and premature completion; these engineering tests do not certify open semantics or gameplay.
