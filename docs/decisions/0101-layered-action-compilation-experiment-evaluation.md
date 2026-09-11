# Layered action compilation experiment evaluation

## Status
Accepted
Class: testing

## Context and Problem Statement

Action compilation retains the original natural-language proposal, but derives descriptions, time plans and dependencies that can change subsequent behavior. Exact source retention and formal validation cannot establish their full meaning. A deterministic-only oracle prerequisite can prevent useful controlled experiments without supplying semantic evidence.

## Decision Drivers

- Preserve gameplay freedom, validation, physical batches and cost ceilings.
- Measure actual initial acceptance separately from recovery and semantic fidelity.
- Avoid circular labels, fabricated human review and unqualified model-as-gold claims.
- Finish fixed comparisons without treating missing semantic evidence as success.

## Considered Options

- Require deterministic predicates to decide all open-language intent before any experiment.
- Treat canonical validation or source-text retention as semantic correctness.
- Separate engineering endpoints, deterministic invariants and calibrated blinded model review.

## Decision Outcome

Use the layered evaluation in [Spec 0024](../specs/0024-action-compilation-constrained-first-pass-experiment.md). Freeze the amendment before paid treatment results. Formal first-pass acceptance is the engineering endpoint; independent model-assisted review is explicitly uncertain semantic evidence, never human gold. Deterministic violations override reviewer opinions. Review disagreement and unobserved outcomes remain unresolved. Semantic claims require calibrated, conservative evidence in addition to engineering gains. Reviewer calls are offline experimental overhead, included in the overall monetary ledger but not gameplay call-count metrics. No review feedback enters compilation or repair.

## Pros and Cons of the Options

### Deterministic-only open-language oracle

- Good: avoids model judge biases where predicates truly exist.
- Bad: confuses a desirable semantic guarantee with an available observation or executable evaluator.

### Formal acceptance as semantic correctness

- Good: immediately measurable.
- Bad: accepts misleading derived descriptions and conflates legality with meaning.

### Layered evidence (selected)

- Good: provides reproducible engineering comparisons and explicit semantic uncertainty without changing game rules.
- Bad: blinded review has correlated model bias; calibration and two agreeing assessments are evidence, not universal correctness guarantees.

## Links

- [Spec 0024](../specs/0024-action-compilation-constrained-first-pass-experiment.md)
- [Real-compiler observability counterexample](../../src/engine/benchmarks/action-compilation/semantic-observability-audit.test.ts)
- Execution and issue record
