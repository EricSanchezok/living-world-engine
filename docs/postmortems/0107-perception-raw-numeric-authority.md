# Perception Retained Model-Authored Check Numbers

Artifact-Version: 1

## Executive summary

A perception diagnostic produced a schema-valid check selecting an observer Rating with value 5 while declaring a zero modifier and DC 0. The resulting unmodified d20 necessarily succeeded. The experiment therefore withheld semantic acceptance despite improved format acceptance and lower observed latency.

## Summary

The onset model schema exposed raw numbers that the action-resolution contract reserves for deterministic derivation. Validation checked that declared modifier sources matched their sum, but did not require the selected observer Rating to participate in that sum. An empty source list and zero modifier passed together.

## Timeline

- A full-world perception comparison used the same complete action scene with thinking disabled.
- One candidate response selected an existing observer Rating, no modifier sources and DC 0.
- The check materialized and succeeded; its cited facts did not establish sufficient perceptual justification.
- Inspection traced the numeric outcome to the perception schema and materializer rather than random sampling or provider reasoning settings.
- The perception contract adopts the existing named/opposed difficulty rules and derives the selected aptitude value mechanically.

## Root cause

Perception retained a raw D20 request interface after action resolution moved to semantic choices with deterministic numeric settlement. Its internally consistent modifier fields could still contradict the separately selected aptitude. A permissive DC range validated shape without establishing numeric authority. Prompt specificity cannot close an interface that still grants this authority.

A subsequent four-case model control exposed stale user-prompt and role-ownership instructions that still assigned modifier sources to the model after the numeric schema changed. All four discriminating state values were present in the actual requests. Three controls failed, including checks for absent sensory access and already established visibility; the causal contribution of the stale ownership and ambiguous accessible-evidence wording requires a separate comparison.

## Guardrails

The [perception numeric contract](../specs/0103-derive-perception-check-numbers.md) removes model-authored check numbers and reuses resolution difficulty evidence, ownership validation and arithmetic. [Real-entry regressions](../../src/engine/mechanics/__tests__/perception-references.test.ts) verify raw-number rejection, exact rating use, source identity, repair and RNG behavior. They inspect the final system, user and role-ownership instructions together, including the distinction between canonical evidence available to Truth and knowledge available to the observer. Full-step reaction tests retain committed-check and replay coverage. Mechanical validation remains separate from necessary-check coverage and perceptual meaning, which require independent experimental evidence.
