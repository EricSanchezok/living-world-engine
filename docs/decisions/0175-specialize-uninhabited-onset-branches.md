# Specialize uninhabited onset branches

## Status

Accepted
Class: architecture

## Context and Problem Statement

Action Compilation exposes typed continuation predicates shared with causal validation. Its Fact and Entity reference resolver issues only current records, while every continuation predicate must already hold at onset. Record-absence predicates therefore have no valid binding in this compilation domain. A present Fact with a none or false value remains a present record.

## Decision Drivers

- Reduce an observed invalid choice using an exact source property.
- Preserve every legal action, condition and temporal selection.
- Retain the original evaluator and failed output evidence.
- Keep later-state causal assertions independent of compilation guidance.

## Considered Options

1. Specialize the experimental wire schema after proving the source domain empty.
2. Keep every causal branch and explain the contradiction in prose alone.
3. Replace a false predicate with a currently true actor prerequisite.
4. Remove absence predicates from the shared causal contract.

## Decision Outcome

The experimental adapter checks the complete actual grounding resolver against the original causal evaluator and binds the source state, execution epoch and request context. It omits only Fact and Entity absence branches from onset wire-schema guidance. The original schema, parser, output preprocessor and compiler validators remain authoritative, including when a model still returns an omitted branch. Every other schema predicate and source field retains its value. Runtime defaults do not select the adapter. The [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns prospective evaluation and admission.

## Pros and Cons of the Options

1. Source specialization removes choices that cannot pass without restricting legal output. It adds local proof work and cannot guarantee generation compliance, relevant conditions or correct task completion.
2. Prose alone preserves the misleading option list and relies on the model to rediscover the same deterministic contradiction.
3. A true replacement need not express the proposed action's condition. Silent substitution changes semantics and hides the rejection.
4. An absence assertion can legitimately hold after a record is removed. Removing it globally restricts causal expressiveness beyond the proven source boundary.

## Links

- [Onset specialization](../../src/engine/benchmarks/step-efficiency/compilation-onset-domain.ts).
- [Grounding reference construction](../../src/engine/mechanics/action-dependency.ts).
- [Causal assertion evaluator](../../src/engine/mechanics/causality.ts).
- [Compilation comparison](../../scripts/experiments/player-compilation-field-domains.ts).
