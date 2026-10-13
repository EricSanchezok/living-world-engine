# Let Jev decisions construct actions and adjudicate world events

## Status

Accepted
Class: architecture

## Context and Problem Statement

The program-based engine makes behavior-tree generation, world-program generation, repairs and semantic evidence prerequisites for ordinary actions. In the frozen C first-input sample, 43 of 47 DeepSeek requests came from program generation or decision fallback, and the sample produced no player feedback. Startup also waits for model work across NPCs. The user approved a replacement that permits ordinary common-sense adjudication and makes creation demand-driven.

## Decision Drivers

- Ordinary natural-language play must produce durable world feedback without generated programs.
- Preserve script-driven generality, private cognition, mechanical consistency and replay.
- Use all native decision primitives and organize context around actual dependencies.
- Keep startup available and failures local; measure complete outcomes and all physical calls.

## Considered Options

1. Direct typed decisions, ActionFrames, persistent intentions and mechanically committed events.
2. Continue refining generated programs, proofs and repair prompts.
3. Restrict the world to a closed catalog of scripted behaviors.

## Decision Outcome

Adopt option 1 under the user-approved [Spec 0182](../specs/0182-jev-direct-world-runtime.md). Jev selects and combines typed actions and adjudicates their semantic consequences. Explicit script rules take precedence; uncovered ordinary behavior permits common-sense interpretation. Code owns numerical effects, valid references, time, atomicity, committed randomness and replay. Semantic evidence is an audit record rather than a requirement for repeated model review.

DeepSeek creates new utterances, concepts, complex strategies and concise reusable capabilities. Generated behavior trees and per-action world programs cease to be prerequisites. Agent goals, activities, delivered observations, waits and receipts persist directly. Save the initial world before model work and use durable local tasks thereafter. A real native context rejection, not a UTF-8 byte estimate, establishes the need for fallback.

The previous implementation is preserved by Git. Its failed experiments remain evidence; they do not become successful baselines or performance claims for the replacement.

## Pros and Cons of the Options

1. Removes structural generation and serial review from routine play, but requires careful action expressiveness, localized scheduling and outcome evaluation; decision confidence cannot establish correctness.
2. Reuses more implementation, but retains the demonstrated source of calls, startup barriers and fragile intermediate structures.
3. Simplifies execution, but cannot support the required novel combinations and open behavior.

## Links

- [Previous architecture](0227-jev-decision-event-engine.md).
- [Current implementation contract](../game-design/direct-runtime.md).
- [Game first principles](0004-game-first-principles.md).
- [TypeSafe API](https://docs.typesafe.ai/api).
- [Function selection and parameter decisions](https://docs.typesafe.ai/cookbooks/function_calling).
- [Jev capability boundaries](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
- [Prior qualification](../research/2026-10-13-jev-engine-qualification.md).
