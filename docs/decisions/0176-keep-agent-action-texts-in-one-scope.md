# Keep Agent action texts in one scope

## Status

Accepted
Class: architecture

## Context and Problem Statement

AgentMind chooses an intended action through three free-text fields. Structural validation cannot establish that its action, goal and means concern the same situation. A private strategic goal may motivate an attempt without describing that attempt's result. Initialization of cognition also does not imply physical arrival. These distinctions matter before any temporal or causal adjudication.

## Decision Drivers

- Preserve autonomous, compound, conditional and ongoing intentions.
- Ground each choice in its character's own perspective and observations.
- Clarify field relationships without silently rewriting generated actions.
- Measure upstream coherence separately from downstream formal acceptance.

## Considered Options

1. Clarify the existing action triplet in an isolated prompt and schema-description experiment.
2. Replace the triplet with one authoritative action text.
3. Infer an immediate action by dropping strategic goals or rewriting mismatched fields.
4. Add another model call to review every generated action.

## Decision Outcome

The experimental AgentMind adapter describes action text, desired result or continuing condition, and intended means as one coherent course of action. It grounds that choice in the slot's own current situation and uses self-contained goal prose. Original fields, value domains, private contexts, target authority, batch size and output validation remain unchanged. The adapter provides no inferred correction or deterministic semantic guarantee. Runtime defaults do not select it; the [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns admission.

## Pros and Cons of the Options

1. Clarification tests a concrete missing producer contract without adding inference calls. It still depends on model compliance and requires complete source review.
2. A single text removes redundant free-text scope choices, but it changes the persistent action contract and requires evidence that legitimate goals and means remain expressible through the whole engine.
3. Dropping or replacing fields can lose intended outcomes and conceal a source contradiction. It is not a lossless repair.
4. A critic can identify disagreements but adds latency, tokens and another fallible semantic judgment to every batch. It does not first remove the observed source ambiguity.

## Links

- [Action-scope adapter](../../src/engine/benchmarks/step-efficiency/agent-action-scope.ts).
- [AgentMind materialization](../../src/engine/algorithms/eager-reference/agent-mind.ts).
- [Bootstrap comparison](../../scripts/experiments/player-agent-action-scope.ts).
