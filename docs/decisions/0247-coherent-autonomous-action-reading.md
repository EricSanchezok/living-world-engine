# Coherent autonomous action reading

## Status
Accepted
Class: architecture

## Context and Problem Statement

Independent choices for an autonomous action's operation, recipient and speech can disagree even when each answer is well formed. Repairing a recipient without a concrete communicative intent can repeat the disagreement and turn intended speech into silent waiting. Generic observation labels also discard why a character inspected something.

## Decision Drivers

Preserve open attempts, private cognition and world-owned adjudication; make goal-directed behavior coherent without forcing activity; reuse existing model profiles and the language interpretation boundary; count actual inference cost.

## Considered Options

- Tune independent branch instructions and repair individual fields.
- Generate a separate natural-language plan before the existing decision and expression calls.
- Bind the complete autonomous attempt in one language response and validate the executed branch.

## Decision Outcome

Bind the complete attempt with the actor's creation profile in the shared language reading boundary. Player and autonomous inputs retain their distinct authority instructions and share catalog binding, audit handling and bounded validation repair. World decisions and the commit kernel retain their existing authority. The autonomous response includes actual words and method, so no separate NPC expression call follows it. Waiting and observation remain first-class choices. Shared world rules and contact checks reference the same retained actions. If native capacity cannot accommodate the complete request, the existing context fallback handles local preflight exhaustion as well as provider rejection; neither case narrows the action or evidence.

## Pros and Cons of the Options

Independent instructions are cheap but cannot guarantee dependent choices describe one intention. A separate planner preserves those calls but adds inference and another representation of intent. Joint reading replaces decision-plus-expression with one logical request and makes binding validation possible; its language-model latency and token cost need live qualification and may exceed a native choice-only call. It does not guarantee useful behavior merely because output is valid.

## Links

- [Change contract](../specs/0194-coherent-autonomous-actions.md)
- [Direct runtime](../game-design/direct-runtime.md)
- [Game first principles](0004-game-first-principles.md)
