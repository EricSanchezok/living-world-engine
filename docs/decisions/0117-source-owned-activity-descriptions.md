# Source-owned Activity descriptions

## Status
Accepted
Class: architecture

## Context and Problem Statement

The compiler can paraphrase an arbitrary action into an Activity description that adds work or turns a prerequisite into an order. The original source action remains available, but downstream adjudication then receives competing descriptions of the task. Describing the original text again also consumes output tokens without being necessary for profile or dependency selection.

## Decision Drivers

- Preserve the complete original action without semantic rewriting.
- Reduce redundant generation while keeping timing and dependency decisions explicit.
- Reject contradictory model output and retain its raw evidence.

## Considered Options

- Let the compiler summarize and rely on later semantic review.
- Require the model to copy every original action verbatim.
- Bind Activity description to the immutable source slot in an explicitly selected representation.

## Decision Outcome

The source-owned representation makes the description optional on the wire and materializes an omitted value from the original action text, bound by action identity and request slot. An explicitly supplied value must match exactly. Contradictory text fails the attempt, retains provider evidence and uses the existing bounded recovery; it cannot pass localized acceptance merely because it is a valid string. Other field errors retain localized recovery. The representation is selected prospectively and does not establish semantic equivalence for historical paraphrases.

The source action remains authoritative. This ownership rule removes one rewriting surface but does not prove correct timing, references, resource use or effects. Those choices retain their existing validators and source-bound review.

## Pros and Cons of the Options

- Model summaries can be concise but introduce an avoidable semantic interpretation before adjudication.
- Verbatim model copying exposes no useful decision and still costs tokens and creates copying failures.
- Source binding preserves exact task text with less generated output. It can produce longer downstream descriptions than summaries, and a contradictory supplied description rejects the whole attempt to prevent canonical schema localization from accepting it.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Semantic and reference boundaries](0086-model-semantic-contract-and-reference-boundaries.md)
- Source-bound evidence and costs
