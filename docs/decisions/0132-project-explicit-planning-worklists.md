# Project Explicit Planning Worklists

## Status

Accepted
Class: feature

## Context and Problem Statement

Shared physical planning requests place the full assigned action inventory inside reconstructed logical contexts. Their outer task contains empty assignment fields and numbered slots. The model must distinguish assigned actions from the full available background while reconstructing shared object overlays and catalog ordering. Enumerating valid action identities in the output schema does not guarantee that generation respects this scope.

## Decision Drivers

- Keep complete actions, background and slot responsibilities.
- Make the actual finite task directly visible.
- Preserve exact source evidence and reject mismatches.
- Account for additive projection tokens instead of assuming savings.

## Considered Options

1. Add a deterministic source-bound worklist and complete target choice index.
2. Rely exclusively on shared-context reconstruction and output enums.
3. Delete available background actions or shrink batches to reduce confusion.

## Decision Outcome

The opt-in projection in [0042](../specs/0042-explicit-physical-planning-worklist.md) exposes complete original assigned records and target choices under the physical task. Canonical context and output handling remain unchanged. The long-context positioning literature motivates a test of accessibility; it does not establish this engine's failure cause or predict its improvement.

## Pros and Cons of the Options

1. The task can be located directly and traced back to exact source slots. Repeated records increase input bytes; only measured reductions in failures and calls can justify that overhead.
2. The representation is compact but leaves source reconstruction to the model; finite schema choices alone do not eliminate unassigned outputs.
3. Removing background or reducing batch size can change semantics and cost independently of task clarity, obscuring the observed failure rather than resolving it.

## Links

- [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172), multi-document question answering and key-value retrieval; not a game benchmark.
- [Shared physical batch contexts](../../src/engine/mechanics/shared-batch-context.ts).
- [Source-bound plan choices](0131-bind-plan-choice-domains.md).
