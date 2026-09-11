# Register the reviewed worklist planning pipeline

## Status
Accepted
Class: architecture

## Context and Problem Statement

The source-bound planning representations can run at the real model boundary during admission diagnostics. Gameplay must identify the same combination through its persisted Composition, including its temporal context policy, rather than relying on an unrecorded provider wrapper.

## Decision Drivers

- Preserve exact source ownership and full action freedom during bounded repair.
- Make candidate execution reproducible from immutable instance and replay identities.
- Keep qualification, semantic review and actual gameplay evidence distinct.

## Considered Options

- Register one explicit candidate Composition with a pinned planning pipeline.
- Replace the default Truth implementation after diagnostic admission.
- Attach provider wrappers only inside the experimental script.

## Decision Outcome

Register a distinct candidate Truth-resolution implementation that composes the existing physical codecs in their qualified order and enables the matching source temporal evidence. Its configuration binds the static instruction bundle and its runner requires complete captured-source reviews. Existing defaults and historical Composition identities remain unchanged. The candidate still incurs the additive worklist context cost and requires actual trajectory validation.

## Pros and Cons of the Options

- A registered candidate records every behavior choice and can be selected by a fresh instance; it adds one explicit registry entry.
- Replacing the default is simpler to launch but diagnostic admission and an uncalibrated same-family reviewer do not establish gameplay or general reliability.
- Script-only wrappers are easy to assemble but would hide model-visible behavior from the persisted algorithm identity.

## Links

- [Registered pipeline contract](../specs/0043-registered-worklist-planning-pipeline.md)
- [Worklist projection rationale](0132-project-explicit-planning-worklists.md)
- [Typed hierarchical Composition](0099-typed-hierarchical-algorithm-composition.md)
