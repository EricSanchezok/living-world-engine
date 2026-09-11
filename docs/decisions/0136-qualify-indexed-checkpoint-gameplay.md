# Qualify indexed checkpoint gameplay at the current state

## Status
Accepted
Class: architecture

## Context and Problem Statement

Mechanical admission of source-indexed plans and a controlled source-intent review diagnostic establish different properties. A failed historical source review cannot be turned into acceptance by changing its reviewer. Repeated static qualification also cannot guarantee that fresh model plans will pass in a new world state.

## Decision Drivers

- Keep historical failures and prospective treatment changes distinguishable.
- Enforce formal and semantic checks on the exact plans about to commit.
- Test real continuous behavior with full action scope and disabled thinking.

## Considered Options

- Promote the mechanically valid historical plans despite their failed review.
- Re-review the same rejected plans with the changed reviewer until accepted.
- Register a new explicit candidate and qualify fresh complete-world behavior under mandatory runtime gates.

## Decision Outcome

An opt-in indexed-reviewed Composition combines reversible physical reference selection with logical source-intent review. It pins both instruction contracts and the existing complete-context foundation. Its launcher selects the separately authored checkpoint world and verifies the frozen mechanical and controlled-review evidence. The failed historical source remains failed; none of its plans are admitted through a replacement verdict.

Fresh plans pass normal runtime validation and semantic review before each commit. Source-bound post-commit review can veto the trial before another step. This diagnostic availability is not default rollout, semantic calibration or a comparative efficiency claim. Three credible steps and independent confirmation retain their existing acceptance boundary.

## Pros and Cons of the Options

- Ignoring the historical rejection would confuse mechanical and semantic evidence.
- Repeatedly changing the reviewer for the same source would select for a desired answer.
- A fresh integrated diagnostic tests the changed treatment at the actual commit boundary and avoids redundant review of discarded plans. It is more expensive than a small fixture and cannot attribute a combined result to one component without further comparison.

## Links

- [Integrated diagnostic contract](../specs/0047-indexed-checkpoint-gameplay-diagnostic.md)
- [Source-indexed references](0134-index-planning-record-references.md)
- [Checkpoint world](0135-adjudicate-generic-short-action-completion.md)
