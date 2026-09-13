# Screen Observer Partitioning After Intact Batch Failures

## Status

Accepted
Class: testing

## Context and Problem Statement

Complete-source perception screens retain systematic invented abilities, observer/source reversal and uniformly incorrect reports. Compiling known relations, clarifying decision branches and factoring repeated catalog fields have not qualified a candidate. The player still fails before the first world commit.

## Decision Drivers

- Preserve every Agent, action, observer and source fact.
- Measure reliable complete-task latency and actual model costs.
- Keep failure evidence and independent semantic validation.
- Avoid using smaller batches as the first response to model errors.

## Considered Options

1. Continue only with intact-batch prompt/schema experiments.
2. Screen observer assignment groups in parallel with full context.
3. Reduce each group's world context or omit distant observers.

## Decision Outcome

Select option 2 for a bounded first-response experiment after the preceding intact-batch interventions. Group all pairs for each observer together; keep the original world in every request. Compare complete waves and explicitly report the increase from one to five physical calls. This decision accepts the experiment, not a default runtime or a qualified gameplay algorithm.

## Pros and Cons of the Options

Option 1 preserves lower call counts but provides no new evidence about correlated task errors or parallel critical-path latency. Option 2 isolates assignment load and offers concurrency, while increasing repeated input and requiring a separate design for global random commitments and terminal transcript merging. Option 3 could reduce cost further, but introduces a second intervention and risks losing relevant causal evidence; it is excluded from this screen.

## Links

- [Experiment contract](../specs/0149-observer-group-perception-screen.md)
- [Relation-domain screen](../specs/0146-perception-check-relation-domains.md)
- [Visibility-branch screen](../specs/0147-perception-visibility-branch-screen.md)
- [Lossless catalog screen](../specs/0148-complete-perception-catalog-factoring.md)
