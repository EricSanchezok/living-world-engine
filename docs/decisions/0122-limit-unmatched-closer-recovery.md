# Limit recovery to unmatched closing delimiters

## Status
Accepted
Class: feature

## Context and Problem Statement

Recorded model batches contain extra closing braces or brackets between otherwise complete plan objects. Existing parsing can reject the entire batch before valid slots reach their ordinary validators. Broad syntax guessing or a model repair can change structure or consume additional work without resolving the original error.

## Decision Drivers

- Preserve source text, field values, references and container openings.
- Fail closed when the restricted interpretation cannot produce one complete strict value.
- Keep syntax recovery distinguishable from formal, semantic and gameplay success.

## Considered Options

- Repeat the complete model request for every remaining syntax error.
- Search arbitrary insertions, deletions and field repairs for a schema-valid result.
- Test deletion of only closers that cannot close the current innermost container.

## Decision Outcome

Implement an isolated, opt-in recovery candidate with the contract in [0031](../specs/0031-unmatched-closer-recovery-experiment.md). A deterministic scan preserves every opener and every matching closer; strings are opaque. Only a closer incompatible with the current innermost container can be removed. The complete result must pass strict JSON parsing and duplicate-key rejection. Exact edits remain evidence, and ordinary downstream validators remain authoritative.

The restricted grammar interpretation is deterministic but does not prove what the author intended in malformed text. Existing parser defaults and historical trial outcomes remain unchanged. Admission to a live experiment requires separate source-bound checks; an offline parseability improvement is insufficient.

When explicitly selected, the restricted interpretation runs after strict parsing and complete top-level corrections, but before broad syntax repair. This avoids letting a broad repair's parseable fragment or altered slot count mask the original complete structure. If the candidate declines, legacy recovery remains available and separately identified; its existing behavior is not evidence for the restricted candidate's guarantees.

## Pros and Cons of the Options

### Repeat model requests

- Retains the existing recovery boundary.
- Repeats large contexts for mechanically detectable punctuation failures and can reproduce them.

### Search arbitrary repairs

- Can recover more malformed outputs.
- May move values between containers, invent missing structure or select among conflicting meanings.

### Delete only unmatched closers

- Preserves all data characters and the nesting implied by retained opening/matching delimiters; performs no model call.
- Leaves incomplete, ambiguous or otherwise invalid outputs rejected and does not resolve invalid references or semantic choices.

## Links

- [Experimental recovery contract](../specs/0031-unmatched-closer-recovery-experiment.md)
- [Existing JSON parser](../../src/engine/models/model-adapter.ts)
- [Real admission and bounded recovery](../../src/engine/benchmarks/step-efficiency/resolution-admission.ts)
