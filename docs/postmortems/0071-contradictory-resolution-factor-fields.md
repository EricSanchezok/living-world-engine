# Contradictory Resolution Factor Fields

Artifact-Version: 1

## Executive summary

A full-source temporal-input probe produced repeated factor contract failures: nonnumeric risk notes carried numeric penalties, and literal authority values were translated. The canonical validator correctly rejected them, but those errors prevented complete admission of otherwise independent plans in the same logical slots. The temporal candidate failed its gate and remained disabled.

## Summary

The observed failure is a model-output contract mismatch, not proof that temporal context causes worse behavior in general. Repeated authority, role, direction and step fields expose combinations the canonical system cannot accept. They make the model coordinate several symbols even when the selected factor type fixes some of them uniquely.

## Timeline

- A prospective first-call comparison preserved full action and state inputs.
- The temporal arm emitted several risk factors with hindering direction and one numeric step.
- Other slots emitted translated authority values; unchanged validation rejected both classes.
- The trial stopped without promotion or further repair calls.
- An opt-in representation replaced authority and role with an explicit factor type and mechanically restored only its canonical literal constants.

## Root cause

The [factor schema](../../src/engine/contracts/llm-schemas.ts) contains dependent literal fields in each legal alternative. The wire contract required those literals repeatedly. A risk note and a numeric control penalty are different semantic choices, so overwriting conflicting values after generation cannot safely repair this mismatch. The experimental codec instead changes what a new model response explicitly selects.

## Guardrails

[Spec 0039](../specs/0039-resolution-factor-types.md) defines exact reversibility and rejection of contradictions. [Codec tests](../../src/engine/mechanics/__tests__/resolution-factor-types.test.ts) cover all legal types and independent source, direction, magnitude and channel choices. [Admission tests](../../src/engine/benchmarks/step-efficiency/resolution-admission.test.ts) preserve valid neighboring slots and route a malformed type back to its original action. These tests establish contract behavior; only prospective source-bound evidence can establish model or gameplay benefit.
