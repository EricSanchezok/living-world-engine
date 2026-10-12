# Execute reusable world and Agent programs with Jev decisions

## Status

Proposed
Class: architecture

## Context and Problem Statement

Living World Engine repeatedly generates and reviews semantic plans and transitions. A persistent world contains reusable rules, recurring action structures and long-lived private intentions. Typed decision models permit semantic conditions and choices to be evaluated independently of generative program authoring. The architecture needs to preserve open actions while making repeated execution incremental.

## Decision Drivers

- Preserve script-driven worlds, arbitrary natural-language intentions and independent cognition.
- Reduce repeated generation and global work without narrowing the world or action semantics.
- Keep deterministic mechanics, random commitments and atomic durable state under code authority.
- Measure complete player outcomes, physical calls and cost, including creation and fallback.

## Considered Options

1. Reusable declarative world and private Agent programs, event scheduling, Jev decisions and on-demand DeepSeek creation.
2. Substitute Jev only for selected reviewers inside the existing generative pipeline.
3. Use a closed handwritten action catalog with decision-model selection.
4. Continue generating and reviewing full plans and transitions at each boundary.

## Decision Outcome

Adopt the program and event architecture under [Spec 0181](../specs/0181-jev-decision-event-engine.md). Code interprets control flow and validates commits; Jev selects actions and evaluates source-bound semantic conditions; DeepSeek authors new programs and content. Libraries expand from script-supported semantics and current authorized context. Private plans and world programs have distinct authority and access scopes.

Program termination, milestone satisfaction and persistent goal completion are separate. Decisions retain unknown and complete evidence bindings. Event subscriptions replace repetitive polling. One ordered world journal and fixed committer preserve causality, time, random commitments and restart safety.

The maintained implementation uses one default execution path. A frozen Git revision supplies the legacy experimental baseline; a second decision provider in the same new architecture isolates model effects from architecture effects.

## Pros and Cons of the Options

1. Reuse and local scheduling remove repeated work and preserve open expansion, but require new contracts, careful program admission and independent outcome qualification.
2. Reviewer substitution limits implementation risk but retains expensive repeated generation and global boundary work.
3. A closed catalog simplifies execution but cannot preserve arbitrary script-driven gameplay.
4. Full regeneration handles new situations uniformly but repeatedly incurs output, repair and semantic review costs for stable behavior.

## Links

- [Game first principles](0004-game-first-principles.md).
- [Persisted execution state](0223-persist-algorithm-execution-state.md).
- [TypeSafe native API](https://docs.typesafe.ai/api).
- [Jev model limits](https://docs.typesafe.ai/models).
- [DeepSeek pricing and model configuration](https://api-docs.deepseek.com/quick_start/pricing/).
- [Full-world repair validation](../research/2026-09-22-step-e3-repair-validation.md).
