# Screen Partially Ordered Action Phases

## Status
Accepted
Class: testing

## Context and Problem Statement

Source-onset summaries ask a model to choose current work directly. Compound intentions can mix concurrent speech, administrative work, future delivery and conditions. Authored staged profiles schedule predefined durations; they do not decompose arbitrary new intentions. Source-owned temporal descriptions deliberately retain the complete original text and are not semantic phase descriptions.

## Decision Drivers

- Expose ordering assumptions as reviewable edges.
- Keep independent attempts concurrent and future prerequisites explicit.
- Retain open actions, complete evidence and private intent boundaries.
- Test the representation before changing runtime authority.

## Considered Options

- Continue generating a direct current-onset summary.
- Require a fixed catalog of primitive world actions and authored decomposition methods.
- Screen open action steps with partial ordering and a deterministic initial frontier.

## Decision Outcome

Use the isolated [action-phase graph screen](../specs/0160-action-phase-graph-screen.md). The model selects semantic steps and constraints; code checks graph structure and derives the initial frontier without completing any step. Source frames remain the experimental control. Neither representation authorizes events, perception or world writes.

## Pros and Cons of the Options

Direct summaries are compact but conceal precedence assumptions. More instructions do not make those assumptions executable or consistent.

A fixed primitive catalog permits stronger planning guarantees when its operators and methods are correct, but importing it as the engine's action vocabulary restricts open semantics and requires world-specific coverage.

Open partial ordering makes precedence inspectable and frontier computation deterministic, at the cost of larger outputs and another unqualified semantic representation. Source quotes and acyclicity do not establish sound decomposition, truthful prerequisites or correct recipient identity. A production benefit requires successful source interpretation and subsequent integration that does not add uncompensated model latency.

## Links

- [Source-onset frames](0205-factor-onset-interpretation-by-source-action.md)
- [Goal-directed temporal activities](0116-goal-directed-temporal-activities.md)
- [SHOP2: An HTN Planning System, JAIR 20 (2003), sections 2–3](https://www.cs.cmu.edu/afs/cs/project/jair/pub/volume20/nau03a.pdf) motivates explicit task decomposition and partial ordering. Its predefined operators, methods, deterministic transitions and planner guarantees are not transferred to this open-language diagnostic. No implementation code is copied.
