# Declare Random Completion with Plans

## Status

Accepted
Class: architecture

## Context and Problem Statement

Resolution separates initial plan commitment from result-dependent discrete random requests. A continuation whose only result is done still requires another complete-context model request. Automatic plan mode does not prove that no authored random distribution applies.

The design borrows binding-time separation from partial evaluation: decisions requiring future evidence remain deferred. An LLM's early semantic declaration is not a deterministic program specialization proof, so the classical equivalence guarantee does not transfer to this experiment.

## Decision Drivers

Preserve arbitrary actions, authored randomness, independent plan review, canonical random ordering and result-dependent continuation. Reduce requests when their decision can be made by the same model with the original complete evidence. Keep the candidate explicitly selected and measurable.

## Considered Options

- Always ask the continuation model after accepting a plan.
- Infer termination mechanically from automatic plans or historical done responses.
- Ask the initial planner for an explicit per-action randomness declaration and retain continuation whenever evidence or repairs invalidate early completion.

## Decision Outcome

The optional indexed reviewed Composition uses explicit declarations bound to individual source plans. Per-action fields survive the existing flat physical plan representation without an unbound parallel list. The engine consumes declarations only after full plan acceptance and under [the completion contract](../specs/0096-plan-declared-random-completion.md). It neither invents the declaration nor equates it with successful world behavior.

## Pros and Cons of the Options

Always continuing retains a later model decision but repeats complete context for termination-only results. Mechanical inference avoids the call but cannot establish whether open actions require authored randomness. An explicit declaration moves the semantic decision into the initial call and permits deferral; it adds a model-visible choice whose accuracy needs random-required counterexamples and live comparisons. Checks and repairs retain the later call, limiting savings in those cases.

## Links

- [Completion contract](../specs/0096-plan-declared-random-completion.md)
- [Canonical ordered random consumption](0105-order-random-consumption-without-resampling-plans.md)
- [Flat plan ownership codec](../../src/engine/mechanics/flat-resolution-plan-batch.ts)
- [Jones, Gomard and Sestoft, Partial Evaluation and Automatic Program Generation, preface and section 1.1](https://book.huihoo.com/pdf/partial-evaluation-and-automatic-program-generation/jonesgomardsestoft-letter.pdf)
