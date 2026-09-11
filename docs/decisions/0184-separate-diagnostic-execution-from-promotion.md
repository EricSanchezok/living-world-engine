# Separate Diagnostic Execution from Promotion

## Status
Accepted
Class: process

## Context and Problem Statement

Small source-bound controls expose semantic counterexamples but do not reveal the complete player's current critical path. The candidate remains unqualified. Requiring qualification for every isolated diagnostic would prevent observation of downstream failures, while silently promoting a failed candidate would weaken the goal.

## Decision Drivers

- Measure the actual 49-Agent player path rather than substitute proxy success.
- Preserve known source failures and the complete acceptance standard.
- Keep experimental state isolated from the user's service and saves.
- Bound new model work and bind evidence to one explicit composition.

## Considered Options

- Continue only small controls until every source passes.
- Treat mechanical success as sufficient for candidate promotion.
- Permit a separately declared, unqualified full-player diagnostic.

## Decision Outcome

Select the bounded diagnostic defined in [0131](../specs/0131-unqualified-full-player-diagnostic.md). Its new producer and protocol explicitly preserve failed prior qualification and cannot imply production promotion or objective completion. The run observes complete player work while retaining all canonical gates. Small controls continue to own their original acceptance claims; no historical result is rewritten.

## Pros and Cons of the Options

### Small controls alone

- Isolate field-level effects and reveal source errors cheaply.
- Leave current full-player latency, downstream repairs and causal completion unmeasured.

### Mechanical promotion

- Moves a candidate to a larger execution quickly.
- Conflates schema validity with correct player experience and discards counterevidence.

### Explicit unqualified diagnostic

- Exposes the real critical path without hiding semantic failures or changing the qualification gate.
- Spends bounded model work on a candidate expected to require further correction and cannot isolate every combined effect.

## Links

- [Diagnostic contract](../specs/0131-unqualified-full-player-diagnostic.md)
- [Complete player objective](../specs/0122-player-action-efficiency.md)
- [Field-domain experiment](../specs/0130-perception-report-field-domains.md)
