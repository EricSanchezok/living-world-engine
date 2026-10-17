# Bind public phase deadlines in existing action interpretation

## Status

Accepted
Class: architecture

## Context and Problem Statement

Authored periodic properties evolve correctly, but a request to rest until the following bright phase still selected ordinary short-duration profiles. Repeatedly asking whether the target had arrived would add calls and could declare completion prematurely. A cycle's current observed value also does not establish knowledge of its complete future rhythm.

## Decision Drivers

- Preserve natural action semantics, exact time and perceptual isolation.
- Reuse the existing interpretation and activity paths.
- Avoid per-checkpoint polling, guessed day lengths and world-specific parsing.
- Retain a submission's temporal reference across prerequisites and restart.

## Considered Options

- Poll a semantic condition at recurring short waits.
- Parse calendar phrases with setting-specific string rules.
- Bind public local phase choices in the existing duration selection.

## Decision Outcome

Expose public containing-place phase choices beside elapsed-duration candidates in the existing action-reading batch. Each transition appears once. The model chooses its entering phase and independently binds either a calendar-cycle offset or a transition-occurrence number; deterministic arithmetic derives its exact deadline. This avoids asking the model to map its understood calendar reference onto a second list of otherwise identical phase occurrences. The first action boundary of the submission anchors relative occurrences. The admitted activity uses the same explicit-duration and interruption machinery as an elapsed interval.

Relative-cycle offsets and occurrence numbers remain distinct, with safe explicit ordinals preserved without enumeration or clamping. Unsupported endpoints, passed references and overflow produce clarification without starting a short activity. Private or merely observed restricted cycles do not enter the predictive catalog. Supporting an explicit restricted-schedule knowledge grant remains a separate contract; current observations alone cannot substitute for it.

Identical inherited public schedules share candidates. Catalog entries carry local descriptions, not canonical identities. They name the current phase and both sides of the selected transition, rather than using a phase's state description as an ambiguous endpoint. Occurrences count those transitions from the request boundary. This increases the existing request's context but adds no mandatory model invocation. Candidate, context, transport and rejection measurements remain part of actual qualification.

## Pros and Cons of the Options

- Polling handles arbitrary changing conditions, but adds repeated decisions and does not guarantee faithful completion of a known periodic endpoint.
- String parsing is cheap for a few phrases, but couples the runtime to vocabulary and cannot reliably distinguish quotations, questions and authorized activity.
- Joint phase selection retains semantic freedom and exact arithmetic, but only predicts publicly authored cycles and requires clarification for unsupported calendars or private schedules.

## Links

- [Periodic endpoint contract](../specs/0201-periodic-phase-activity-deadlines.md)
- [Periodic property derivation](0258-derive-periodic-properties-at-atomic-clock-boundaries.md)
- [Real-engine deadline regressions](../../src/engine/direct/__tests__/periodic-deadlines.test.ts)
