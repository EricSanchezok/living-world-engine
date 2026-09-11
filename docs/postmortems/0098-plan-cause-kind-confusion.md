# Plan cause kinds confused with supporting sources

Artifact-Version: 1

## Executive summary

Complete planning requests returned entity sources in plan causes even though the canonical schema permits only existing actions, events, facts and laws. The validator correctly rejected them. An optional explicit source-index representation removes redundant kind/ref spelling while retaining all legal choices and validation.

## Summary

The failed trajectory and a later complete two-root diagnostic both included entity causes. In the latter, two plans failed even though the complete action index set was present. A separately discovered prompt mismatch listed seven cause kinds while the plan schema allowed four. Entities were forbidden in both descriptions, so the mismatch alone does not explain those outputs or prove the cause of model behavior.

## Timeline

- The plan schema excluded post-plan evidence, while an older prompt retained a broader causal vocabulary.
- Full-context outputs confused supporting entities with legal plan causes.
- A layout and intent reminder improved some observed descriptions but still returned two illegal entity causes.
- The prompt vocabulary was aligned and an optional source-index codec added with exact round-trip and invalid-slot tests.

## Root cause

The output representation asks the planner to reproduce a discriminator already bound to every catalog reference. Supporting sources and causal references share similar object shapes but different legal domains. This is an avoidable representational exposure, not proof that all grounding failures share one cause.

## Guardrails

The [source-indexed planning tests](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) retain all four legal source kinds, invalid-selection rejection and independent valid slots. The [registered game entry test](../../scripts/operations/step-plan-cause-choices.test.ts) verifies actual configuration reaches the physical model boundary. The [contract](../specs/0086-source-indexed-plan-causes.md) preserves mechanical and semantic validators and requires fresh paid evidence before any promotion.
