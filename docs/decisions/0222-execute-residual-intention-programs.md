# Execute residual intention programs

## Status

Accepted
Class: architecture

## Context and Problem Statement

The diagnostic intention producer supplies sequence, parallel and conditional structure, but ordinary execution treats its complete embedding as one natural-language action. Initial-frontier annotations do not retain progress or establish when later work becomes executable. A lifecycle kernel is needed to make those distinctions deterministic without interpreting arbitrary prose as world effects.

## Decision Drivers

- Preserve complete intentions, local target ownership and open action semantics.
- Separate an issued attempt, committed completion and remaining work.
- Resume without duplicating actions or reusing obsolete condition decisions.
- Keep private cognition separate from canonical world state.

## Considered Options

1. Execute a residual program using committed Activity evidence and source-bound private guard decisions.
2. Add more instructions describing the initial frontier to the existing whole-action model request.
3. Replace every compound intention with its first leaf and discard the rest.
4. Derive natural-language guard truth directly from canonical state.

## Decision Outcome

Use an isolated residual interpreter under [Spec 0176](../specs/0176-incremental-intent-execution.md). The interpreter exposes work, binds issued child actions, consumes committed completions and retains an explicit remaining program. It has no authority to write the world or establish natural-language truth. Product adoption requires atomic cursor/world persistence and qualified guard and resource integration.

The design borrows the distinction between one transition and legal termination from IndiGolog's online execution semantics. It does not implement its theorem prover, assume guarded action axioms for arbitrary prose, or inherit the paper's correctness theorem.

## Pros and Cons of the Options

1. Residual execution makes progress and ordering persistent and testable. It introduces lifecycle and interruption obligations and can still receive semantically wrong guard decisions.
2. An annotation is small and retains the source, but leaves progress reconstruction and ordering to each model response.
3. Keeping one leaf is cheap but loses future alternatives and does not preserve the chosen intention.
4. Canonical evaluation can exploit hidden facts unavailable to the acting Agent and cannot generally interpret arbitrary conditions without semantic adjudication.

## Links

- [Incremental Execution of Guarded Theories, De Giacomo, Levesque and Sardina, ACM TOCL 2(4), 2001](https://www.diag.uniroma1.it/~degiacom/papers/2001/DeLS01tocl.pdf).
- [Intent program contract](../specs/0161-agent-intent-program-screen.md).
- [Initial frontier annotation](../specs/0170-initial-intent-frontier-screen.md).
