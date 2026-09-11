# Goal-directed temporal activities

## Status
Accepted
Class: architecture

## Context and Problem Statement

Finite natural-language work can have a meaningful completion objective without a verified duration, quantity or explicit continuation condition. A fixed schedule asserts a completion time; a conditional profile requires an onset-true condition; an ongoing profile has no goal-achievement completion. Forcing finite work into those contracts can discard part of its scope or encourage an invented prerequisite.

## Decision Drivers

- Preserve arbitrary complete actions without inventing durations, quantities, prerequisites or achieved effects.
- Keep world-authored timing and deterministic interruption, resource ownership and replay.
- Permit progress checkpoints and supported terminal adjudication with nonthinking models.

## Considered Options

- Describe finite work using conditional profiles and require a condition for every task.
- Assign a conservative fixed duration or open-ended ongoing profile.
- Add an explicit goal-directed profile using the existing checkpoint and outcome machinery.

## Decision Outcome

The `goal` profile represents finite work whose completion is adjudicated from the original action, world rules, state and proposed effects. It has an authored check interval and no predetermined completion time. Continuation assertions express actual additional prerequisites and may be empty. A checkpoint alone never establishes success. A supported succeeded outcome completes the Activity; continuing preserves it, and failed or blocked outcomes terminate it through the existing mechanism. Conditional profiles retain their required condition and ongoing profiles retain their open-ended behavior.

The script selects the available profiles. The compiler selects a profile and preserves the original source action; the kernel does not classify natural language or supply a missing condition. Resource claims, eligibility, reactions, causal checks and transaction replay use their existing owners. Formal acceptance cannot establish arbitrary goal achievement; source-bound effect review remains necessary.

## Pros and Cons of the Options

- Conditional reuse avoids a new profile kind but requires a condition even when the action supplies none; a fabricated identity guard hides this representational gap.
- Fixed duration adds unsupported timing. Ongoing represents indefinite duties and does not complete from an achieved finite goal.
- Goal-directed profiles preserve this distinction with one additional script discriminant and shared runtime paths. They require explicit semantic completion evidence and cannot make an unreliable adjudicator correct by construction.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Event-boundary temporal runtime](0070-event-boundary-temporal-runtime.md)
- [Activity reactions and temporal selection](0073-stage-reactions-before-temporal-boundary-selection.md)
- Source-bound experiment evidence and costs
