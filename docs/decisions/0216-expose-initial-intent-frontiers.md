# Expose initial intent frontiers

## Status

Accepted
Class: architecture

## Context and Problem Statement

Intent programs contain complete attempted sequences, parallel branches and conditions. A planner receives the entire program together with temporal evidence but has no explicit structural starting point. Treating a later objective as an immediate result can remain mechanically valid while violating the action's causal order.

## Decision Drivers

- Preserve open intentions and the complete world context.
- Reuse deterministic structure already supplied by the intention producer.
- Avoid inventing condition truth, progress or durations.
- Isolate the intervention without extra model calls.

## Considered Options

1. Add a source-bound initial-frontier view for provably initial Activities in a benchmark screen.
2. Ask another model to extract a phase graph from the same intention.
3. Replace the full intention with only its first attempted step.
4. Introduce a persistent execution cursor and execute program nodes directly.

## Decision Outcome

The benchmark provider uses the existing intent-program inspector and adds an initial-frontier view for eligible assigned actions. Full source programs and canonical validation remain authoritative. Conditions remain unevaluated and later execution receives no reset-to-start claim. [Spec 0170](../specs/0170-initial-intent-frontier-screen.md) owns eligibility, provenance and validation. No runtime default selects the screen.

## Pros and Cons of the Options

1. A deterministic view makes the existing starting structure explicit without another call. It increases input size and cannot establish that a natural-language attempt is completed or semantically correct.
2. Model extraction supports arbitrary prose but adds cost and another fallible interpretation of existing structure.
3. Replacing the intention shortens context but removes alternatives and dependencies that can affect present adjudication.
4. A persistent cursor can support demand-driven execution, but needs a separate lifecycle and adjudication contract for completion, interruption and conditions. An initial structural view alone cannot supply those semantics.

## Links

- [Intent program inspector](../../src/engine/benchmarks/step-efficiency/agent-intent-program.ts).
- [Activity temporal evidence](../../src/engine/contracts/activity-temporal-evidence.ts).
- [Action phase graph screen](../specs/0160-action-phase-graph-screen.md).
- [Frontier provider](../../src/engine/benchmarks/step-efficiency/initial-intent-frontier.ts).
