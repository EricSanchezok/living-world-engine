# Include Bound Targets in Dependency Reads

## Status
Accepted
Class: bug-fix

## Context and Problem Statement

Original actions name actor-local targets with existing canonical bindings. A model can omit those targets from its dependency selections, leaving a subsequently chosen means outside the committed grounding even though the original action already names the object. Dependency enrichment already supplies actor and placement references but does not cover these exact target identities.

## Decision Drivers

- Preserve original target evidence without guessing referents or action meaning.
- Cover scheduling dependencies before resolution, without another model call.
- Keep means validation and world semantics authoritative.
- Measure the cost of conservative dependencies on the complete action graph.

## Considered Options

- Ask the compiler to repair every omitted bound target.
- Permit arbitrary canonical means regardless of grounding.
- Add the complete existing binding union of original targets as entity reads.
- Add each target and all of its associated world records as reads and writes.

## Decision Outcome

Choose the exact entity-read union in [Spec 0168](../specs/0168-bound-target-dependency-reads.md). Multiple identities remain multiple possible dependencies, not a selected referent. The shared materializer applies the same rule to compilation and grounding, and implementation versions bind the changed behavior to new Composition hashes.

## Pros and Cons of the Options

Model repair adds latency for identities the engine already has. Unrestricted canonical means bypass conflict declarations. Transitive record expansion and automatic writes overstate the source evidence and can collapse independent work. The exact entity-read union preserves validation and eliminates this omission, but may add conservative conflict edges for targets in later or conditional parts of an action. Semantic validation must still establish whether a selected means is useful and available.

## Links

- [Dependency materialization](../../src/engine/mechanics/action-dependency.ts).
- [Resolution source inventory](../specs/0028-resolution-source-inventory-experiment.md).
- [Algorithm identity contract](../game-design/algorithm-system.md).
