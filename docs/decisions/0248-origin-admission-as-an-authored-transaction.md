# Origin admission as an authored transaction

## Status
Accepted
Class: architecture

## Context and Problem Statement

An Origin can establish a newcomer's numerical profile but cannot establish their family, possessions, obligations or reciprocal recognition. Existing-character play also needs a selected authored identity without creating a duplicate. Both requirements belong to script-driven participation, including worlds unrelated to Fanren.

## Decision Drivers

- Keep the catalog snapshot immutable and preserve canonical replay.
- Validate the complete initialization before any instance is persisted.
- Reuse entity, fact, cognition and control structures.
- Keep player customization separate from authored mechanical and historical authority.
- Permit simple arrivals and socially established identities through the same commit path.

## Considered Options

- Pre-create every possible player identity as a permanent NPC and only transfer control.
- Rewrite the world's initial state separately for each selected Origin before bootstrap.
- Extend admission with an authored additive seed and expose existing-identity entries through the same participation catalog.

## Decision Outcome

Extend the admission transaction with authored entities, facts, resources and reciprocal cognition. Script loading validates references and capabilities against the same world definition. Admission stages all additions on a copy, rejects identity collisions and invalid references, and records the complete seed for replay. Existing-identity entries use control transfer without an admission or duplicate entity.

The client selects an Origin and supplies bounded cosmetic text and current motivation. It cannot submit seed operations, grant capabilities or choose arbitrary canonical targets. Existing-identity customization follows the entry's restrictions. Relation hooks remain readable descriptions; executable relations live in facts and individual cognition.

## Pros and Cons of the Options

- Pre-creating all identities gives real relationships cheaply, but reserves a cast for choices the player never makes and cannot represent a genuinely new entrant.
- Rewriting the initial state avoids an admission record, but makes the catalog hash insufficient to identify the history base and introduces a second initialization authority.
- Authored admission preserves the existing replay boundary and supports both sparse and rich Origins. It requires explicit reference validation, cognition merge rules and invalidation of affected prepared actions.

## Links

- [Approved world and participation scope](../specs/0195-canonical-world-and-participation-seeds.md)
- [Canonical committer](../../src/engine/runtime/canonical-committer.ts)
- [Admission impact proof](../../src/engine/runtime/admission-impact.ts)
- [Script format](../game-design/script-format.md)
