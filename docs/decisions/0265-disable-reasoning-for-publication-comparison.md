# Disable reasoning for publication comparison

## Status
Rejected
Class: architecture

## Context and Problem Statement

The user requests lower API consumption while retaining substantive review. Publication compares candidate paragraphs with fixed evidence through six existing checks. In bounded merchant play, its six Flash calls spent 23,527 reasoning tokens within 23,851 output tokens, yet the overall run still failed natural-play acceptance. This establishes cost and a failed run, not that reasoning caused the errors or that disabling it preserves quality. The narrative reference and the broader reasoning policy also disagree about the effective setting.

## Decision Drivers

- Reduce measured generation work without dropping evidence or review axes.
- Preserve the existing publication boundary and its bounded repair allowance.
- Retain low reasoning for open language interpretation and creation.
- Pin the effective settings and all failed calls in model audits.

## Considered Options

- Inherit low reasoning for publication and every other language boundary.
- Disable reasoning only for the existing closed publication comparison.
- Remove publication checks or introduce a separate cheaper critic.

## Decision Outcome

Do not promote the second option. Retain [0236](0236-reasoning-for-language-boundaries.md): `decision-deepseek` and `creation-deepseek` remain pinned to Flash with low reasoning, including publication. A single bounded probe verified zero reasoning tokens but failed to identify a known elapsed-time error on the evidence axis. Its factually supported comparison paragraph also repeated earlier content, so it was not a clean positive control. The request differed from the historical single-paragraph request; neither quality equivalence nor a causal comparison is established.

The [bounded validation record](../../worlds/fanren/authoring/validation/publication-cost-validation.json) retains the candidate settings, complete answer set and 14,042 input-plus-output tokens. Keep the independently verified native-profile connection and lossless source-review optimizations. Native publication uses its supported inference settings and registered instruction profile; a context-limit fallback retains the full state, questions and configured language profile. Do not remove evidence checks or continue paid trials merely to obtain a passing example. Reduced usage is not complete-world acceptance.

## Pros and Cons of the Options

- Inherited low reasoning retains one shared profile policy but spends substantial output on a closed comparison, without qualifying the observed run.
- A task-owned override removes that reasoning work while preserving all checks and context. The bounded probe did not qualify semantic reliability, so the lower usage does not justify promoting the exception.
- Removing the check weakens the evidence boundary. A separate critic adds another request and another handoff without demonstrated benefit for this failure.

## Links

- [Publication reference](../game-design/narrative.md)
- [Model gateway](../game-design/model-gateway.md)
- [Entry-point regression tests](../../src/server/__tests__/world-narrative.test.ts)
- [Publication policy and native-profile incident](../postmortems/0194-publication-check-lost-inference-policy.md)
