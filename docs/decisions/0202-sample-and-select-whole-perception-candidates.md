# Sample and Select Whole Perception Candidates

## Status

Accepted
Class: testing

## Context and Problem Statement

Identical complete perception requests produce different failures: missing evidence references, wrong reference kinds, unsupported checks and observer/source inversions. A repaired read controller still leaves semantic errors. Input, schema and draft-layout experiments do not qualify a complete candidate. Additional computation may help if independently sampled proposals contain a valid interpretation and selection can recognize it, but neither premise is established for this world.

## Decision Drivers

- Preserve full world scope, semantic freedom and canonical validation.
- Measure parallel sampling against serial recovery costs.
- Keep required randomness distinct from sampling model responses.
- Retain rejection and abstention rather than manufacture agreement.

## Considered Options

1. Continue one proposal followed by sequential repair.
2. Sample bounded whole proposals in parallel, screen mechanically, then select or abstain against full evidence.
3. Vote over report verdicts or combine fragments from different proposals.

## Decision Outcome

Select option 2 for the [bounded experiment](../specs/0156-sampled-perception-candidate-selection.md). Every proposal uses the original canonical task. The selector returns an eligible candidate index or abstains; it cannot rewrite a result. A shared pure check-materialization function keeps proposal screening aligned with runtime validation before random commitment. This decision accepts the experiment, not a default algorithm or a reliability claim.

## Pros and Cons of the Options

Option 1 uses fewer initial calls but sequential failures delay all later phases. Option 2 spends more tokens and adds selection latency, while parallel proposals may supply a better alternative without repair. The selector can still share the generator's semantic errors. Option 3 can exploit valid neighbors but needs a new global consistency and check-commitment contract; a majority verdict alone cannot establish a sensory route or override an authored rule.

## Links

- [Self-Consistency, abstract and method](https://arxiv.org/html/2203.11171v4): motivates sampling alternative model completions. This experiment uses neither chain-of-thought traces nor answer voting, and transfers no benchmark score or independence guarantee.
- [Training Verifiers, sections 1 and 4](https://arxiv.org/html/2110.14168v2): motivates generating candidates and selecting with verification. This experiment has no separately trained verifier or exact arithmetic answer oracle; a prompted same-model selector may fail.
- [Player acceptance contract](../specs/0122-player-action-efficiency.md)
