# Shared native decision context

## Status
Accepted
Class: architecture

## Context and Problem Statement

Fanren sample qualification produced a native context rejection for 89 world questions. The request repeated the complete policy in every question and repeated action frames already present in shared state. The language fallback then exhausted its output limit. Reducing question count would remove joint context or require more paid calls before addressing the redundant serialization.

## Decision Drivers

- Preserve every authorized fact, question and answer domain.
- Keep private projections and their hashes unchanged.
- Reduce actual wire size before changing batch cardinality or model profiles.
- Pin the transport layout in the decision producer identity.

## Considered Options

- Lower batch size and repeat the world state across more calls.
- Increase limits or routinely route large native requests to the language fallback.
- Share the policy and reference complete action frames within the existing request.

## Decision Outcome

For record-shaped native state, add the common policy once to a transport copy under an unused key. Questions reference that policy. Scalar and array projections retain their shape and inline policy. World and witness questions identify actions by ID; the complete action remains in the same authorized state. No state evidence, criteria or questions are pruned. Cache and audit identity include the wire layout version.

A replay of the same 89-question batch reduced compact HTTP JSON from 214,838 to 121,202 UTF-8 bytes. The native model returned all 89 answers in one dispatch, with no context fallback. The provider reported 47,076 input and 4,128 output tokens for that replay. This establishes transport feasibility for this case, not whole-world scalability or a general latency claim. Numeric-effect and movement qualification remain separate behavioral checks.

## Pros and Cons of the Options

- Smaller batches can fit a ceiling but duplicate state and increase calls; they do not remove the redundancy responsible for this case.
- Larger limits or a different model can accommodate the request but retain avoidable input and alter cost or behavior.
- Shared references preserve the question set and one-call adjudication. They require resolvable action IDs and a layout-aware prompt identity. A genuinely oversized authorized view can still exceed the provider's context.

## Links

- [Decision transport and regressions](../../src/engine/models/__tests__/decision-v2.test.ts)
- [Direct execution contract](../game-design/direct-runtime.md)
- [Sample qualification failures](../postmortems/0183-shared-context-and-meter-ownership.md)
