# Alias Repair Diagnostics Mixed Namespaces

Artifact-Version: 1

## Executive summary

A fresh full-world trajectory stopped before its first commit because Action Compilation repeatedly selected an Agent as a conflict dependency. The final repair prompt expressed candidates, allowed references and previous output as short aliases, but retained the rejected originalValue as a canonical candidate key. The repair evidence did not consistently identify the wire value it described.

## Summary

The invalid Agent remained rejected correctly; no state commit or automatic reference substitution occurred. The failure preceded Truth planning, so it did not test the recently admitted Truth transport candidate. The escaping defect is a representation inconsistency in feedback, not evidence that Agents should become legal conflict dependencies.

## Timeline

- The initial compilation batch produced a disallowed Agent dependency.
- Two localized repairs retained the same invalid candidate in requiredExistingCandidateKeys.
- The last captured input showed previousAttempt and allowedHandles in alias form, but originalValue in canonical-key form.
- The trajectory stopped with revision and step unchanged; all active model requests settled.
- A real compiler regression reproduced the namespace mismatch before the correction.

## Root cause

The context codec converted named reference fields and separately encoded previousAttempt using the output schema. It intentionally avoided replacing arbitrary strings, so the generic originalValue field was omitted. There was no schema-bound comparison between the rejected value and its encoded previous output. Globally replacing strings would be incorrect because literal facts, descriptions and arbitrary random-result JSON can legitimately resemble candidate keys.

## Guardrails

The [codec](../../src/engine/algorithms/eager-reference/action-compilation-representation.ts) compares diagnostic originalValue with the exact canonical previousAttempt path. It updates the value only when the output schema's reference conversion changes that same value. Literal, mismatched or missing evidence remains untouched; temporal reshaping does not choose a different reference. Canonical audits and source text stay intact. [Codec regressions](../../src/engine/algorithms/eager-reference/__tests__/action-compilation-representation.test.ts) cover aliases, nested references, opaque literal JSON and mismatches. [Real compiler repair regression](../../src/engine/algorithms/eager-reference/__tests__/representation-trajectories.test.ts) rejects an Agent dependency, verifies consistent next-request evidence, accepts a model-provided correction and preserves the baseline compiled activity and source state. Paid effectiveness and full-world acceptance require new separately frozen evidence.
