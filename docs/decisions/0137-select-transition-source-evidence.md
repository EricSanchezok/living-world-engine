# Select Transition Source Evidence

## Status

Accepted
Class: simplification

## Context and Problem Statement

The experimental transition interval interface needs source-bound evidence and separation of current from unfinished work. Requiring a model to copy nested state values duplicates immutable input and creates another opportunity for syntax or value corruption. Asking for a second free-text plan creates an opportunity to rewrite conditions and responsibilities without adding authoritative state.

## Decision Drivers

Preserve open action semantics, minimize generated structure, retain auditable source bindings and keep semantic claims distinct from mechanically verified references. The experiment uses a non-thinking hosted model and cannot rely on stronger inference or extra online review calls.

## Considered Options

- Copy full evidence values and regenerate unfinished work in prose.
- Select source pointers and exact unfinished-action ranges.
- Remove evidence and unfinished-work representation entirely.

## Decision Outcome

The unpromoted transition interface selects existing source values and exact source text ranges. It retains model-authored requirements, gate states and current-work summaries. Source values and passages can be reconstructed from the frozen request; the runtime never invents missing semantic content. [Specification 0057](../specs/0057-transition-source-selections.md) owns the contract and prospective admission gate.

## Pros and Cons of the Options

Copying values makes responses self-contained but generates redundant nested JSON, while free-text unfinished plans can alter the action being evaluated. Source selection removes those copying and paraphrasing obligations while keeping the complete source available. It requires the request to interpret a response and cannot prove relevant selection, complete coverage or entailment. Removing the evidence interface is simpler but loses an explicit boundary between supported current work and deferred intent; it offers less diagnostic evidence for temporal mistakes.

## Links

- [Current interval contract](../specs/0055-transition-current-interval.md)
- [Lossless source segments](../specs/0056-transition-source-segments.md)
- [Source selection implementation](../../src/engine/mechanics/transition-interval-assessment.ts)
