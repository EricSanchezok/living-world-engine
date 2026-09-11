# Use action-local means positions

## Status

Accepted
Class: feature

## Context and Problem Statement

One complete planning output transposed characters in a twelve-character hashed means selector. The intended nearby choice remained visible, but correcting it would guess the model's intended evidence. The hash is a reliable identity token for code, yet unnecessary text to reproduce when the action already owns an ordered complete source inventory.

## Decision Drivers

Reduce representational failure and output length while retaining complete source choice, action ownership and strict validation.

## Considered Options

- Retain hashed selector generation and rely on repair.
- Match invalid selectors by edit distance.
- Let the model explicitly select an action-local integer position.

## Decision Outcome

Offer optional local positions through the existing indexed planning codec. Every selected position restores one exact existing selector from that action's complete inventory. Keep the original selector decoder and grounding validator; do not infer a selection for old invalid output.

## Pros and Cons of the Options

Hashes keep code identities explicit but are costly to copy reliably. Fuzzy repair can silently change evidence and is rejected. Local positions eliminate that copying burden with a small input annotation; they may still be chosen incorrectly and require semantic review. The changed model-visible representation requires a fresh experiment.

## Links

- [Action-local means contract](../specs/0087-action-local-means-indices.md)
- [Indexed plan causes](0149-index-existing-plan-causes.md)
