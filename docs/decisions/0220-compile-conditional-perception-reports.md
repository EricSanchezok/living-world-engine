# Compile conditional perception reports

## Status

Accepted
Class: architecture

## Context and Problem Statement

The onset protocol requests checks and later asks the model for reports using their fixed results. A supported check may therefore require multiple serial model calls even when its possible report branches can be expressed in advance. Repeated interpretation can introduce new checks, invalid references and redundant output.

## Decision Drivers

- Reduce serial inference while preserving warranted uncertainty and actual RNG.
- Keep conditional hypotheses distinct from accepted world and observer evidence.
- Retain ordinary interpretation for decisions that cannot be compiled in advance.

## Considered Options

1. Compile an initial check batch and conditional report graph, with explicit deferral.
2. Retain a model call after every check round for all reports.
3. Replace uncertain perception with an estimated or averaged report.
4. Require a complete policy for every possible later check and outcome.

## Decision Outcome

The benchmark uses option 1 with TruthEngine's actual initial request and shared check, RNG and receipt functions. The model declares checks and branch-dependent reports; local graph execution chooses reports from the actual resolved checks. Explicit deferral returns the whole report decision to the ordinary protocol, replaying the declared initial batch with its one paid audit and the same original RNG. Compiled work does not fabricate model invocations. [Spec 0174](../specs/0174-conditional-perception-report-programs.md) owns the contract. No registered runtime Composition adopts this capability.

The design borrows the separation of advance planning, information gathering and explicit decision steps from contingency planning. It does not implement Cassandra's search algorithm, its action theory or its correctness argument. Sharing report nodes is a representation choice; Cassandra discusses branch merging as a prospective extension, not a demonstrated guarantee this implementation can inherit.

## Pros and Cons of the Options

1. Compiled branches can remove a result-following HTTP call while retaining the original check and receipt validators. They add output and may still contain semantic errors; selected reports remain subject to normal validation.
2. Ordinary interpretation remains expressive but incurs serial inference even for straightforward conditional reports.
3. Averaging or substituting certainty changes the world's committed random history and can erase perception opportunities.
4. Exhaustive policies can grow combinatorially and are unnecessary when the model can explicitly defer an unresolved case without changing the ordinary execution contract.

## Links

- [Planning for contingencies: A decision-based approach](https://www.cs.cmu.edu/afs/cs/project/jair/pub/volume4/pryor96a-html/final-jair.html), Pryor and Collins, JAIR 4 (1996), 287–339.
- [Representing Decisions](https://www.cs.cmu.edu/afs/cs/project/jair/pub/volume4/pryor96a-html/node12.html), explicit decision steps and information requirements.
- [Branch Merging](https://www.cs.cmu.edu/afs/cs/project/jair/pub/volume4/pryor96a-html/node44.html), the motivation and stated limitation of shared continuations.
- [Perception report program](../../src/engine/benchmarks/step-efficiency/perception-report-program.ts).
- [Original observer-bound onset receipts](0181-project-onsets-before-agent-reactions.md).
