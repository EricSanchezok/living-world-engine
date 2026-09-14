# Separate Intent and Planning Reference Domains

## Status
Accepted
Class: testing

## Context and Problem Statement

An embedded intention and a planning output both use targetIndices, with different local and global meanings. Structurally valid planning selections can therefore reference subjects unrelated to the intended action. A more precise meter rejection does not qualify a condition attached to the wrong subject.

## Decision Drivers

- Preserve every selected intention and its original local perspective.
- Make reference origin explicit without guessing canonical identities.
- Remove an overlapping vocabulary before adding repair calls.
- Compare a lossless representation independently from semantic admission.

## Considered Options

- Add another reminder about the two numeric domains.
- Restrict planning targets to the intention's resolved entities.
- Present intention parameters as named local symbols with per-action binding tables.
- Delete the intention tree or select only its first attempt.

## Decision Outcome

Use the benchmark-only [scope-qualified intention screen](../specs/0166-scope-qualified-intent-reference-screen.md). Its parametric syntax view preserves the complete source and binds names within each action. Canonical identities and target-selection freedom remain with the existing world evidence and adjudication. It adds neither an execution interpreter nor a second canonical action format.

## Pros and Cons of the Options

A reminder retains the same ambiguous numeric spelling. Restricting the target universe can exclude a legitimate affected bystander or unresolved referent. Deleting later work changes the selected undertaking. Named parameters separate the input vocabulary and preserve full freedom, at the cost of a binding table and longer symbols. The model must still judge relevance; a valid binding does not guarantee a semantically correct effect.

## Links

- [Recursive intention compilation](0210-compile-nested-intentions-to-indexed-programs.md).
- [Binding as Sets of Scopes](https://www-old.cs.utah.edu/plt/publications/popl16-f.pdf), Matthew Flatt, POPL 2016, introduction and section 2: syntax retains binding origin to avoid accidental capture. This motivates domain separation; the screen does not implement Racket's macro expander or inherit its correctness guarantees.
