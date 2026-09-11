# Onset reports lacked observer-local references

Artifact-Version: 1

## Executive summary

Onset perception asked for claims in an observer's local identity namespace while supplying no such references in common actual requests. The terminal materializer used a different private resolver from the request's Truth catalog. A valid existing local identity was therefore unavailable to the model or rejected after generation. A broad output schema also permitted canonical identities where only local identities could be materialized.

## Summary

Fresh paired controls under the observer-receipt protocol returned canonical player references in stimulus claims. Inspecting the actual visible-control request found zero local-entity handles, empty availableLocalEntityRefs and localEntityBindings, and a task claiming no allowed proposals despite permitting local introductions. The model had been told to choose an available local identity without receiving one. Canonical evidence and role instructions were present; this was an input/validation contract mismatch, not proof that the model ignored a supplied local identity.

## Timeline

- Receipt integration reused private stimulus materialization but retained the older perception catalog, which only included local entities explicitly targeted by acting Agents.
- Real response screening exposed canonical references in positive stimulus claims; the initial hypothesis concerned schema precision.
- Full request inspection established the missing local catalog and different resolver namespaces. A focused gateway-to-Truth regression failed before the fix, including a scheduled observer with no action of their own.
- The producer, request projection and receipt materializer now share observer-qualified Truth handles, with explicit owner validation before creating the observer's private stimulus.

## Root cause

The old perception stage requested checks only. Adding terminal observer reports changed what its output needed, but the input catalog was not extended for that responsibility. The actor projection silently omitted missing local handles. Its actor scope also omitted a non-acting observer without grounding evidence. The private renderer resolved short local names, while Truth used observer-qualified names; even adding references to the old catalog alone would not align them.

Tests covered empty-claim stimuli or new introductions and did not select an existing identity from the exact outbound request through the real gateway. Those branches passed without exercising the missing dictionary. The shared claim schema described a generic reference instead of its actual local-entity requirement.

## Guardrails

The [Truth context and catalog](../../src/engine/contracts/prompts.ts) include every assigned observer and their complete existing local references, including bound, unbound and ambiguous identities. This reuses observer-qualified Truth identity representation; unrelated canonical evidence and check fields remain intact. [Perception catalog uses](../../src/engine/contracts/perception-references.ts) permit local claim targets while check actor and target schemas still require canonical entities. Local introductions are declared as permitted proposals.

[Private stimulus materialization](../../src/engine/cognition/observation-materialization.ts) resolves those exact supplied handles and checks their observer ownership and existence, then emits private local IDs. It neither guesses an alias from canonical identity nor introduces replacement identities. [Claim schemas](../../src/engine/contracts/llm-schemas.ts) require local-entity references or declared proposals for subjects and entity-valued claims; canonical bindings remain confined to validated introductions.

The [real-gateway regression](../../src/engine/mechanics/__tests__/perception-local-context.test.ts) selects supplied identities, verifies initial success and targeted recovery, rejects canonical and cross-observer misuse, and preserves source state and RNG. [Actual AgentMind entry](../../src/engine/algorithms/eager-reference/__tests__/onset-isolation.test.ts) confirms the existing identity survives without canonical bindings or private action text entering cognition. Existing introduction, observation, commitment and receipt regressions remain applicable. This implements the [approved observer-receipt contract](../specs/0128-observer-bound-onset-receipts.md); model semantic reliability and full-player latency require fresh evidence. More complete identity input has a measurable context cost and is not claimed to guarantee fewer repairs.
