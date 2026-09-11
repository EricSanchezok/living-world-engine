# Schema Error Wrapping Erased Repair Paths

Artifact-Version: 1

## Executive summary

A full-world step compiled all 48 actions on its first attempts, then exhausted transition repairs. The model omitted required arrays, but repair feedback discarded the validator's field paths and reported only a generic schema failure.

## Summary

STEP-E1 trajectory 08 stopped without a state commit. All provider calls returned responses; this was a model-output and repair-feedback failure rather than a network incident. The experiment record owns the trial inputs, failures and costs. Preserving actionable schema feedback addresses a confirmed defect but does not guarantee that subsequent model attempts will succeed.

## Timeline

- Four complete compilation batches passed with no repair.
- A transition output omitted `mechanicInvocations`, `operations`, `events` and `decisionRequests`. Zod reported each missing field separately.
- The adapter and gateway wrapped that Zod error in model-output errors.
- The repair context contained one generic issue with an empty path. A later repair corrected an outcome status while again omitting the required arrays, exhausting the available attempts.
- A regression through the real gateway and adapter reproduced the loss of all four field paths.

## Root cause

The shared prompt issue projector recognized a direct Zod error but treated wrapped model-output errors as unstructured messages. The transport abstraction correctly preserved the original cause and raw output; the repair boundary failed to use them. Unit coverage of direct schema validation did not exercise the adapter and gateway wrappers before generating repair diagnostics.

## Guardrails

The [issue projector](../../src/engine/contracts/prompts.ts) traverses only a bounded, acyclic chain of model-output wrappers to recover a Zod error. Other error meanings retain their existing projection. The [gateway regression](../../src/engine/models/__tests__/model-provider.test.ts) verifies that all four missing-array paths reach repair diagnostics and that the raw incomplete output stays unchanged. The engine does not fill arrays, rewrite references or relax output validation to obtain a pass.
