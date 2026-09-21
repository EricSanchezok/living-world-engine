# Co-generate Uncommitted Plan and Transition Candidates

## Status
Accepted
Class: architecture

## Context and Problem Statement

World resolution generates plans, reviews them, settles random commitments and then generates a transition. When reviewed initial plans explicitly require no randomness, the transition has no random result to wait for. Its generation can be attempted with the plans, but that draft cannot become authoritative before the plans and the transition pass their separate validators.

## Decision Drivers

- Reduce serial inference and repeated world input while preserving complete actions and open semantics.
- Preserve independent plan review, pre-draw commitments, canonical mechanics and final causal review.
- Measure failed speculation and larger joint output alongside any saved request.

## Considered Options

- Keep separate generation for every plan and transition.
- Co-generate a provisional transition and consume it only after the existing planning gates.
- Merge Agent cognition, world truth and final validation into one inference.

## Decision Outcome

The diagnostic tests guarded co-generation under [Spec 0179](../specs/0179-fuse-reviewed-plan-and-transition-generation.md). This transfers the physical subtask-combination idea from PALIMPZEST, not its quality estimates or equivalence guarantees. A shared model output is an untrusted proposal and may have different semantics or greater latency than separate generation. Source tests and fresh gameplay determine usefulness.

## Pros and Cons of the Options

### Separate generation

- Good: the transition sees accepted plans and completed random evidence directly.
- Bad: even a deterministic trajectory waits for another inference.

### Guarded co-generation

- Good: deterministic accepted plans can use an already generated transition while retaining downstream validation.
- Bad: combined output and instructions grow; rejected plans or stochastic work waste the provisional draft. Semantic correctness still needs independent evidence.

### One unrestricted inference

- Good: fewer serial calls.
- Bad: mixes private cognition with canonical truth and lets unvalidated proposals determine later decisions or randomness.

## Links

- [A Declarative System for Optimizing AI Workloads](https://arxiv.org/abs/2405.14696), Section 3.4, motivates combining physical LLM subtasks; dependency preservation and quality evaluation remain separate obligations.
- [Declare random completion with plans](0156-declare-random-completion-with-plans.md).
- [Truth Engine](../../src/engine/mechanics/truth-engine.ts).
