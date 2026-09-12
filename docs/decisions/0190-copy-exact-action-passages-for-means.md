# Copy Exact Action Passages for Means

## Status
Accepted
Class: testing

## Context and Problem Statement

The planner repeatedly rewrites complete action prose into grounded means descriptions. A source reference and a paraphrased description can disagree even when both pass structural checks. Generating this prose also occupies a substantial part of complete planning output. Exact copying can avoid unnecessary regeneration without claiming that copied player intentions are canonical facts.

## Decision Drivers

- Preserve all original action text, free description generation and evidence selection.
- Reduce paraphrase opportunity and output length without another model call.
- Keep source choice and semantic adjudication model-owned.
- Bind copies to the current assigned action and preserve old failures.

## Considered Options

- Continue generating every means description as free text.
- Automatically replace descriptions with the original action.
- Offer exact action-local passages alongside free strings.
- Remove means descriptions entirely.

## Decision Outcome

Implement the isolated experiment in [0137](../specs/0137-copy-source-action-passages-in-means.md). An explicit copy index selects one displayed exact passage; ordinary strings retain their original meaning. Complete original fields and punctuation-delimited passages are available without ranking or semantic selection. The existing decoder chain and world validators remain unchanged.

## Pros and Cons of the Options

Free generation preserves flexibility but pays for repeated prose and may alter conditions or subjects. Automatic replacement can change a selected method and hide a failed output. Removing descriptions discards model-owned distinctions used in review. Explicit copying retains flexibility and exact provenance but adds input, may select the wrong passage and may not reduce actual latency. The full action remains the review authority, so selecting a fragment cannot excuse omission of a condition.

## Links

- [Pointer-generator networks](https://aclanthology.org/P17-1099/) motivate combining source copying and free generation. This adapter does not implement or train the paper's neural architecture, and its summarization results do not predict game performance.
- [Indexed means sources](../../src/engine/mechanics/source-indexed-planning.ts) remain independent of copied text.
- [Plan source-intent review](../../src/engine/prompts/shared/plan-review-source-intent.md) rejects unsupported achieved-result claims, including those in means.
