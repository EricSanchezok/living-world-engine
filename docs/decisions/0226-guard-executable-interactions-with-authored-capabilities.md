# Guard Executable Interactions With Authored Capabilities

## Status
Accepted
Class: architecture

## Context and Problem Statement

The [P0 audit](../research/2026-09-22-step-e3-p0.md) finds that existing quantities and identities do not prove contact, delivery or observation. A runtime experiment needs executable rules without converting missing world semantics into implicit facts.

## Decision Drivers

- Run the entire diagnostic and distinguish compiler, rule, world-source and critical-path failures.
- Preserve arbitrary actions and complete-component fallback.
- Keep world-specific permissions and communication physics in authored world data.
- Reuse existing canonical materialization and commit authority.

## Considered Options

- Infer communication and visibility from placement or model declarations.
- Require explicit versioned source capabilities, with ordinary adjudication for residual work.
- Expand a universal social and physical rule library before testing.

## Decision Outcome

Implement [Spec 0180](../specs/0180-executable-interaction-diagnostic.md) with source-authored capability facts and a separate diagnostic producer. The model proposes bindings and exact source partitions. The runtime validates the capability, identities, timing and current source before deriving events or operations. Complete components retain original final review and commit validation. The rule set provides no universal semantic proof; compiler mistakes remain independently reviewable failures.

## Pros and Cons of the Options

### Placement inference

- Good: applies to many existing actions with little new data.
- Bad: invents audibility, delivery, access and sometimes a collective mind.

### Explicit capabilities and residual fallback

- Good: makes missing contracts observable, admits controlled counterfactuals, and gives deterministic operations a concrete source.
- Bad: W0 may have little coverage; compilation and fallback can add latency. W1 cannot establish W0 effectiveness.

### Universal rule library

- Good: could broaden eventual coverage.
- Bad: mixes extensive world engineering with the algorithm experiment and delays useful failure evidence.

## Links

- [Game first principles](0004-game-first-principles.md).
- [Persistent algorithm execution state](0223-persist-algorithm-execution-state.md).
- [Executable interaction diagnostic](../specs/0180-executable-interaction-diagnostic.md).
- [Executable interaction verification](../../src/engine/benchmarks/step-efficiency/executable-interaction.test.ts).
