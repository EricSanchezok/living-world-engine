# Derive local activity work from existing causal records

## Status

Accepted
Class: architecture

## Context and Problem Statement

A participant's overnight rest kept the clock active but excluded nearby ready replies unless their immediate cause was the participant. A local buyer could speak while the seller remained ready until dawn. Correct elapsed time therefore omitted already established local work. Related work can also temporarily leave the room or fall between the participant's authorized steps.

## Decision Drivers

- Admit actual local work without unconditional global simulation.
- Preserve causal follow-through, private perspectives and motivated silence.
- Reuse existing interpretation batches, durable records and restart semantics.
- Keep the participant's requested deadline and interruption contract unchanged.

## Considered Options

- Admit only immediate reactions to participant actions.
- Interpret every globally ready character during each long activity.
- Persist a separate actor cohort for each participant activity.
- Derive the current local work window from unfinished submissions, locality and causal records.

## Decision Outcome

Derive a local window from current participant activities, or the last executed step of an unfinished participant submission. Seed eligible actors using actual placement and established goal or commitment links. Follow current ready or active intents whose completed causal actions fall inside the root work's time window. Admit eligible ready actors alongside direct participant reactions in the existing interpretation opportunity. Starting a new participant continuation also admits local work only after it produces an actual action frame.

This avoids a new persistent cohort and scheduler invocation. It retains existing action, delivery, wait and no-progress semantics. The cost is scanning durable action records and performing genuinely necessary local decisions; locality does not supply hidden knowledge or promise that any character will agree.

## Pros and Cons of the Options

- Immediate participant reactions are inexpensive but omit NPC-to-NPC continuations and starve independent nearby work.
- Global readiness covers every actor but turns one foreground activity into unrelated world-wide work and makes latency depend on distant readiness.
- A persistent cohort can store explicit admission provenance but introduces a second lifecycle and save contract where existing intent causes suffice.
- Derived membership reuses replayable causal evidence and existing locality, but must remain anchored to unfinished work so an old encounter cannot permanently recruit a distant actor.

## Links

- [Local causal work contract](../specs/0203-local-causal-work-during-participant-activities.md)
- [Scheduling implementation](../../src/engine/direct/initiative.ts)
- [Real-entry regression tests](../../src/engine/direct/__tests__/local-activity-window.test.ts)
- [Incident and permanent guardrails](../postmortems/0190-long-rest-starved-local-ready-work.md)
