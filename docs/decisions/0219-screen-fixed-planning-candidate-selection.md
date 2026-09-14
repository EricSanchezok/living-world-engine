# Screen fixed planning candidate selection

## Status

Accepted
Class: architecture

## Context and Problem Statement

Planning proposals can pass canonical materialization while containing unsupported semantic claims. Selecting among proposals is useful only if the selector can distinguish support in the original source. Fresh proposal sampling adds inference cost before that prerequisite is established.

## Decision Drivers

- Test selection separately from proposal generation and sample diversity.
- Preserve complete source evidence and whole candidate identity.
- Keep diagnostic admission separate from semantic correctness and committed gameplay.

## Considered Options

1. Test a selection-only model on three frozen planning proposals.
2. Immediately generate three fresh proposals and select one.
3. Select the first mechanically valid proposal or use majority agreement.
4. Merge or repair candidate fields during selection.

## Decision Outcome

The benchmark tests a frozen pool through a selection-only request with full source context and explicit abstention. It screens candidates with the original request decoder, schema and runtime materializer, then returns the selected raw proposal unchanged for execution revalidation. The bounded automatic-plan scope and verification duties belong to [Spec 0173](../specs/0173-fixed-planning-candidate-selection.md). No registered runtime Composition selects this screen.

## Pros and Cons of the Options

1. The fixed pool isolates the selector's behavior and avoids new generation cost. One choice cannot establish reliability, independent samples, general planning coverage or net latency improvement.
2. Fresh sampling measures the combined method but pays for generation before establishing selection quality and confounds an empty valid pool with selector failure.
3. Mechanical admission and agreement do not establish source support. These policies lack the required semantic comparison.
4. Editing or merging changes the hypothesis being tested, introduces another generation task and obscures whole-candidate provenance.

## Links

- [Planning candidate selector](../../src/engine/benchmarks/step-efficiency/planning-candidate-selection.ts).
- [Whole perception candidate selection](0202-sample-and-select-whole-perception-candidates.md), including its research provenance and limits.
- [Canonical cause representation](0218-isolate-canonical-plan-cause-references.md).
