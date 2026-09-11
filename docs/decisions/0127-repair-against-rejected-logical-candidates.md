# Repair Against Rejected Logical Candidates

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

Logical repair issues name fields in a rejected output, but an isolated model request cannot locate those fields without that output. Regenerating from source and error strings permits previously valid plans to change unnecessarily. A physical response can contain several independent candidates with different owners.

## Decision Drivers

- Make exact field diagnostics actionable without interpreting action semantics.
- Preserve joint planning and complete validation.
- Keep physical and logical candidate ownership distinct.
- Limit retry context to one rejected candidate and retain first-request identity.

## Considered Options

1. Include the complete latest rejected logical candidate as bound, uncommitted repair evidence.
2. Provide only error messages and regenerate from source.
3. Require field patches or automatically retain selected valid plans.

## Decision Outcome

Truth retries include a detached candidate with source and invocation bindings. The semantic loop clears stale evidence when a rejection lacks an output. Codecs preserve the logical owner and exact field representation. Complete output remains the model's responsibility and passes existing validation. [Spec 0037](../specs/0037-truth-rejected-candidate-repair.md) defines the contract and trial boundaries.

## Pros and Cons of the Options

1. Full candidate evidence makes paths and preserved content available without an additional call. It adds retry input tokens and can anchor the model to a flawed draft, so source semantics remain independently assessed.
2. Message-only repair saves candidate tokens but leaves output-relative paths unbound and encourages unrelated regeneration.
3. Patches can reduce output tokens but require a new dependency-aware edit contract. Automatically retaining individual plans risks changing joint semantics or missing dependent edits.

## Links

- [Semantic repair loop](../../src/engine/models/semantic-repair.ts).
- [Physical repair evidence](../../src/engine/prompts/repair-layout.ts).
- [Slot evidence isolation](../postmortems/0068-cross-slot-normalization-repair-evidence.md).
