# Omit the source-owned description field

## Status

Accepted
Class: architecture

## Context and Problem Statement

Source-owned Activity descriptions can already be omitted and restored by immutable action identity. The optional field remains visible in the output schema, however, so a model can still generate a contradictory paraphrase despite the instruction to omit it. This introduces another model decision about data the engine already owns.

## Decision Drivers

- Preserve complete source action text without interpreting or summarizing it.
- Remove a redundant generation surface while retaining original semantic duties.
- Compare fresh responses under a separately pinned representation.

## Considered Options

- Retain the optional field and strengthen the copying instruction.
- Accept or overwrite generated paraphrases.
- Remove the field from the output schema and retain source-bound restoration.

## Decision Outcome

Expose `original-action-omitted-v2` as an independent experimental policy. Its wire schema omits the source-owned field and its prompt explains the same ownership boundary. It uses the existing restoration and contradiction checks. The `original-action-v1` policy remains available for prospective comparisons with its existing prompt and schema; neither policy supplies model-owned timing or dependency choices.

## Pros and Cons of the Options

Stronger copying instructions retain unnecessary output work and a conflicting schema affordance. Accepting paraphrases or silently replacing them can hide changed action meaning. Schema omission removes that affordance and preserves exact source text, but hosted JSON mode does not enforce omission by itself. The candidate therefore needs measured first-response and complete compiler results; smaller schemas and passing codecs do not establish gameplay success.

## Links

- [Candidate contract](../specs/0116-omit-source-description-from-output-schema.md)
- [Source-owned Activity descriptions](0117-source-owned-activity-descriptions.md)
- [Source binding and schema adapter](../../src/engine/algorithms/eager-reference/source-action-description.ts)
