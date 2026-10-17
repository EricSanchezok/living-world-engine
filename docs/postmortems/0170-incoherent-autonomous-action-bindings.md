# Incoherent autonomous action bindings

Artifact-Version: 1

## Executive summary

A ten-boundary observer run showed repeated inspections while most selected speech never became a delivered action. Independent answers for operation, listener and expression were individually valid but did not describe one executable intention. A recipient-only retry could select none again, after which execution silently waited. Mechanical observer text made this look like a world limited to observation.

## Summary

The preserved baseline and contradictory invocation are recorded in [Spec 0194](../specs/0194-coherent-autonomous-actions.md#evidence). The actor's goals and persona were present in the request; this was not missing goal configuration or a provider outage. Other actors executed physical actions, establishing that the engine could commit more than observation.

## Timeline

1. The user advanced ten observer boundaries and reported repeated observation and unreadable context.
2. Ledger inspection located contradictory operation/listener choices and the silent wait substitution.
3. Joint action qualification produced motivated dialogue and physical attempts, then exposed duplicated world requests and a memory preflight error that bypassed the existing large-context fallback. Regression coverage now exercises this path without reducing the batch or discarding evidence.
4. Recorded execution replay exposed a missing preflight rejection event. The gateway now records this non-transport outcome, and both replay and checkpoint recovery reproduce it before consuming the saved fallback response.
5. Fresh multi-component qualification exposed a shared world invocation counter: completion order assigned different identities to later expansion/admission calls during replay. Each concurrent component now owns a deterministic invocation namespace, retaining concurrency and call count. A persistent-host regression reverses response order and checks exact replay.

## Root cause

The action representation required dependent choices but asked the decision provider to select them independently. Natural-language expression followed those choices and could not repair their shared purpose. The silent wait fallback hid that contradiction from ordinary gameplay. The memory capacity guard raised a local context error before native transport, while the existing fallback recognized only a provider rejection. Large joint world requests therefore failed before reaching the configured fallback. Repeated contact rules and full action bodies amplified those requests. Live fallback requests then exhausted all 8,192 output tokens on reasoning and returned no JSON, including the bounded retry. The decision profile now leaves 32,768 tokens for reasoning and answers while retaining low thinking effort. Observer summaries repeated the same appearance as both an entity detail and a fact, included generic visibility placeholders, and did not clearly identify whose experiences the conversation represented.

## Guardrails

The [joint action decision](../decisions/0247-coherent-autonomous-action-reading.md) binds an NPC's full next attempt in one language response and validates its executed branch through the existing interpretation boundary. It preserves voluntary waiting and purposeful observation. Invalid speech receives one complete repair, with exhausted failure retained explicitly. World adjudication remains independent of the proposed intention.

[Runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) exercise speech/listener coherence, bounded repair and failure, observation-to-dialogue-to-wait continuity, actual delivery, goal non-completion, appearance deduplication, cognitive isolation and replay through the simulation entry. [Host regressions](../../src/server/__tests__/direct-world-host.test.ts) preserve interaction continuation and participant completion. [Observer browser coverage](../../e2e/flows/immersive-game.spec.ts) exercises the selected perspective and controls; [visual coverage](../../e2e/flows/conversation-visual.spec.ts) checks responsive reading and footer separation. Real observer qualification evaluates delivered acts and consequences, rather than treating an action-kind quota as evidence of initiative.

[Decision gateway regressions](../../src/engine/models/__tests__/decision-v2.test.ts) cover both provider overflow and local capacity exhaustion with full context retained; preflight fallback makes only one actual model call. [Concurrent action regressions](../../src/engine/direct/__tests__/activities.test.ts) retain world semantics while sharing rules and action references.

The persistent host regression also forces native preflight rejection and verifies exact recorded candidate replay plus checkpoint recovery without live transport. The rejected preflight identity remains in the event payload, avoiding a phantom pending invocation in Inspector.
