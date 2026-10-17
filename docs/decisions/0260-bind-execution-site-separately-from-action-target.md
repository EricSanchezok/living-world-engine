# Bind execution site separately from action target

## Status

Accepted
Class: architecture

## Context and Problem Statement

A semantic target can denote an object watched, a person awaited or a movement destination. It cannot simultaneously establish where the actor performs the action. A request to work in another known room needs arrival, while a sentence mentioning that room need not authorize travel. Attempt prose is not a placement receipt.

## Decision Drivers

- Preserve the player's requested place and freedom of action.
- Keep actual placement authoritative.
- Reuse movement settlement and the bounded interpretation repair.
- Avoid extra mandatory calls and world-specific phrase parsing.

## Considered Options

- Treat a nonmovement target as an implied movement destination.
- Rely only on descriptive instructions about missing arrival.
- Bind the next action's execution site separately and validate it against current placement aliases.

## Decision Outcome

The player reading binds an execution site in the same response as operation, target and expression. A nonmovement step requiring another place enters the existing single consistency repair. The corrected step may be an authorized move, a current-site prerequisite or clarification. The ordinary transaction path establishes arrival before continuation can work there. All exact aliases of the current place are accepted; canonical identities remain inside the engine.

This introduces one semantic field and a small current-site boundary in the existing interpretation call. It does not guarantee correct interpretation of every natural-language reference; it makes an explicitly contradictory interpretation rejectable without silently transforming the player's action.

## Pros and Cons of the Options

- Automatic target-based movement is simple but changes the meaning of waiting, observation and speech, and can invent travel authorization.
- Instructions alone retain a small schema but cannot deterministically reject an activity that claims another place while placement stays unchanged.
- Separate binding preserves the target's meaning and reuses existing movement and repair paths, but adds context and requires the model to identify the intended execution site faithfully.

## Links

- [Execution-site contract](../specs/0202-action-execution-site-binding.md)
- [Incident and actual-model evidence](../postmortems/0189-intended-site-was-not-completed-arrival.md)
- [Real-entry site regressions](../../src/engine/direct/__tests__/activity-site.test.ts)
