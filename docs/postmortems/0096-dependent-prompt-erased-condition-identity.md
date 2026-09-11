# Dependent-field prompt erased condition identity instructions

Artifact-Version: 1

## Executive summary

A representation adapter replaced the complete effect instruction asset when changing magnitude and opposed-source fields. That asset also contained an independent condition-reference rule. The replacement omitted the rule, so the physical indexed plan requests lacked instructions for binding a new condition to its declaring effect. The rule has a separate shared asset included outside the replaced representation instructions.

## Summary

A complete-world diagnostic failed before its first state transition. Its final six-slot plan repair contained eleven condition proposal references that were not declared in their corresponding outputs. The canonical prompt contained the needed identity rule, but the actual model request did not. This establishes an instruction-preservation defect; it does not establish that restoring the instruction eliminates every model reference error or all other plan failures.

## Timeline

- The canonical effect instruction included both magnitude constraints and condition identity rules.
- The dependent-field adapter replaced the whole asset with instructions for its two derived fields.
- A fresh full-world diagnostic exhausted plan repair with undeclared condition references.
- Inspection of the recorded HTTP body confirmed the independent rule was absent.
- A regression through the physical indexed pipeline failed for both single and shared requests before the instruction was separated.

## Root cause

Instruction asset boundaries did not match the adapter's responsibility. Replacing a semantically mixed asset silently removed an unrelated requirement. Codec round trips checked output data, while deterministic model fixtures did not depend on the emitted instructions. Schema-valid proposal references can still be semantically undeclared, so schema coverage alone could not expose the missing guidance.

## Guardrails

The [shared condition rule](../../src/engine/prompts/shared/resolution-condition-references.md) is composed outside the replaceable effect representation. [Physical indexed pipeline tests](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) require it in single and shared requests; [batch adapter tests](../../src/engine/mechanics/__tests__/resolution-dependent-fields-codec.test.ts) require exactly one copy. The [normalizer](../../src/engine/contracts/model-context.ts) still rejects undeclared proposals; no output correction or validator relaxation accompanies the prompt fix. The [representation contract](../specs/0030-dependent-resolution-fields-experiment.md) retains all independent choices and full context. Paid validation uses frozen full requests and reports semantic uncertainty separately from formal admission.
