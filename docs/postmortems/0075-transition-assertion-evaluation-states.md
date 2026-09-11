# Transition Assertion Evaluation States

Artifact-Version: 1

## Executive summary

A full-world transition asserted elapsed time below its checkpoint on an outcome evaluated after the engine advanced time to that checkpoint. The engine correctly rejected the assertion. The task prompt instructed every assertion to use the current input state, contradicting the evaluator's distinct operation, mechanic, and final-state phases.

## Summary

Assertion truth depends on both its content and evaluation state. Correcting the prompt aligns the model contract with the existing validator; it does not relax causality or establish model reliability.

## Timeline

- A goal activity entered a ten-second transition boundary from time zero.
- Its continuing outcome asserted elapsed seconds less than ten.
- Final-state causality rejected that assertion after time advancement.
- An earlier isolated wording experiment had failed overall behavioral admission; its correct description of evaluation phases remained outside the shipped prompt.
- The runtime prompt includes the existing phase contract and removes contradictory input-only instructions.

## Root cause

The shared Truth role conflated operation preconditions with all causal assertions. The transition task reinforced the conflation by requiring current elapsed time everywhere. The evaluator checks direct and mechanic-derived operations sequentially before each operation, mechanic invocation assertions against the original input, and event and outcome assertions after operations including final time advancement. An unrelated terminal failure in a twelve-slot batch omitted required arrays and exhausted repair; the clock defect is not the sole cause of that failed step.

## Guardrails

The [transition prompt bundle](../../src/engine/prompts/index.ts) loads the [evaluation-state contract](../../src/engine/prompts/shared/transition-assertion-states.md). The [runtime-bound regression](../../src/engine/benchmarks/step-efficiency/transition-assertion-prompt.test.ts) inspects the actual request from a conditional scenario, checks sequential placement preconditions and final witnesses through the [causality evaluator](../../src/engine/mechanics/causality.ts), and rejects a stale boundary-clock outcome without mutating source state. Frozen benchmark transformations reject contract drift rather than silently comparing identical arms. No historical failure is relabeled as a pass; fresh paid behavior and complete gameplay remain separate acceptance gates.
