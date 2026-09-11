# Reference the trusted boundary clock

## Status

Accepted
Class: feature

## Context and Problem Statement

Outcome clocks are known from the trusted temporal boundary, but generating them independently can conflate a checkpoint with a completion deadline. A valid continuing status does not imply elapsed time is before the next checkpoint. Repeating this mistaken comparison can reject an entire component and regenerate unrelated outcomes.

## Decision Drivers

Retain arbitrary action effects, keep actual assertion evaluation strict, reduce redundant model choices, preserve source identity and avoid extra calls or stronger inference.

## Considered Options

- Continue asking the model to generate every clock comparison from numeric source fields.
- Correct failed comparisons after generation.
- Let the model explicitly reference the supplied final boundary clock and decode that selection into an assertion, retaining arbitrary additional assertions.

## Decision Outcome

Use the third option in an opt-in configuration. The wire selection names a trusted source value; the existing causal evaluator decides whether that expected clock is actually reached. The decoder neither settles actions nor repairs semantic errors. Additional assertions remain intact, including false ones that cause rejection.

## Pros and Cons of the Options

Independent numeric generation retains flexibility but duplicates deterministic work. Correcting false comparisons can change model meaning and hide errors. A bound selection removes that particular calculation and keeps failure visible if source or actual execution diverges. It adds a fixed clock witness to each outcome and cannot prove that any proposed event or effect is correct. The additional assertion channel retains other timing constraints.

## Links

- [Boundary clock contract](../specs/0084-source-bound-boundary-clock.md)
- [Event-sourced summaries](../specs/0083-event-sourced-outcome-summaries.md)
