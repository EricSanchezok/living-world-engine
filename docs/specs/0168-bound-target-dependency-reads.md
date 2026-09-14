# Bound Target Dependency Reads

Artifact-Version: 1
Status: Approved

## Intent

Preserve exact original target bindings in the dependency evidence used for conflict scheduling and resolution means. This addresses an observed omission under the [complete-player experiment](0122-player-action-efficiency.md) without adding model calls or weakening reference validation.

## Contract

Interaction dependency materialization includes entity reads for every existing canonical entity bound to a known actor-local target named by the original action. It uses only that actor's local entity and binding records. Multiple bindings contribute every existing identity conservatively; missing or empty bindings contribute none and never acquire a guessed identity. A binding to a nonexistent canonical entity is invalid source state and fails closed. Original model-selected reads and writes, mandatory actor and placement references, audience, resources and fallback flags retain their existing meaning.

These reads identify possible source dependencies, not intended effects, writes, perceptual access or semantic permission to use an object arbitrarily. They do not add an entity's facts, meters, ratings or placement transitively. The original source validator still rejects unrelated means references and the Truth Engine still adjudicates relevance, timing and consequences. The same materializer owns initial compilation and later grounding. Compiler and grounding implementation versions change so existing Composition identities cannot silently acquire different dependency behavior.

## Plan

Implement the complete binding union in the shared dependency enrichment. Exercise actual compilation, plan validation, canonical commit and replay with an original bound target omitted by model-authored dependencies. Retain malformed-reference rejection and unresolved target semantics. Quantify changed reads, conflict edges and component membership across the complete frozen forty-nine-action source before a fresh paid trial. Preserve historical requests, failed responses and source hashes.

## Verification

Test zero, one and multiple canonical bindings, duplicates, owner-local alias collisions, unknown local targets, invalid bindings, source immutability, conservative conflict edges, first-pass use of the original bound object and rejection of unrelated means. Verify current registry resolution and rejection of previous compiler and grounding identities. Run relevant tests and check:fast, commit the producer, freeze the new source and trial, and record transport usage and independent semantic results. A recovered component is not proof of full-player correctness or the sixty-second objective.

## Evidence

[Decision 0214](../decisions/0214-include-bound-targets-in-dependency-reads.md) owns the conservative-union rationale. [Bound-target regression tests](../../src/engine/mechanics/__tests__/bound-target-dependencies.test.ts) own materialization, scheduling and real-entry behavior.
