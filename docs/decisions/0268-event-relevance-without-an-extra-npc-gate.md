# Filter incidental NPC wakes in existing world adjudication

## Status

Accepted
Class: architecture

## Context and Problem Statement

Receiving a nearby interaction currently makes each witness eligible for creative action interpretation. A changing clock also defeats identical-input reuse. Large local groups can therefore repeatedly reconsider incidental conversation even though they should remember it and continue their own affairs.

## Decision Drivers

- Preserve autonomous goals, natural language and private cognition.
- Reduce unnecessary creative calls without a second execution path or an extra per-Agent classifier call.
- Keep perception, wake eligibility and the eventual voluntary action distinct and replayable.

## Considered Options

- Disable natural-language decisions for unobserved NPCs.
- Add a separate cheap-model gate before every creative decision.
- Classify passive event relevance in the existing world batch and deduplicate clock-only wake inputs.

## Decision Outcome

Choose the existing-batch approach. Only a clearly incidental passive observation defers reconsideration; ambiguity, direct interaction and independent work remain eligible. The trusted adjudicator receives compact recipient concerns, but ordinary Agent contexts retain their cognitive boundary. All delivered observations persist. Temporal triggers and new outcomes bypass clock-only reuse. This changes scheduling eligibility, not the set of actions or the source of world truth.

## Pros and Cons of the Options

- Observer-based intelligence would save calls but make the same world behave differently when watched and weaken offscreen causes.
- A separate gate has a clean interface but adds serial calls and duplicate context to every decision.
- Existing-batch relevance adds closed questions and a small amount of private concern context. Its semantic judgments can be wrong, so uncertain cases remain eligible and direct addressees cannot be suppressed. It avoids a new model round trip while preserving one execution path.

## Links

- [Approved cost policy](../specs/0207-relevant-npc-wakes-and-model-cost-policy.md)
- [Direct runtime](../game-design/direct-runtime.md)
