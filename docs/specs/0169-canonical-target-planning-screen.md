# Canonical Target Planning Screen

Artifact-Version: 1
Status: Approved

## Intent

Isolate target reference spelling under the [complete-player experiment](0122-player-action-efficiency.md). Indexed planning can choose the wrong entity while broader canonical-reference ablation also removes useful means and factor constraints. This screen changes only plan and effect target selection.

## Contract

A benchmark-only adapter accepts the complete indexed planner after its action-local means, factor, cause and tail transformations. Plans emit ordered canonical entity targetRefs; each non-null effect emits one targetRef present in that list. The exact existing worklist supplies the complete legal target domain and original slot permissions. No target is selected, inferred, ranked, truncated or retargeted by the adapter. Repeated target references and their order remain legal. Multiple occurrences of the same entity have identical canonical effect ownership; decoding uses their first occurrence without changing the canonical plan.

The adapter restores existing target indices and effect positions before the original decoder. Invalid, unknown, cross-slot, missing or mixed selections retain a rejection marker and their original rejected value; valid neighboring plans remain intact. Original action coverage, means positions, factor types, cause indices, ratings, meters, evidence, time and canonical validation remain authoritative. Complete context and source annotations remain unchanged. The generated schema shares the full canonical target domain and replaces only the two target fields. Both system and tail use the same external target instruction. Source, domain and schema mutation fails closed. Ordinary requests and runtime Composition registration remain unchanged.

## Plan

Reuse the benchmark source-domain guard. Verify the whole existing representation pipeline, original canonical schemas and physical gateway before freezing an independent paired first-planning screen on the same complete forty-nine-action source. Count all calls and preserve failures without repair or resampling. Historical response conversions serve only as deterministic transport fixtures.

## Verification

Cover repeated and empty targets, both effect kinds, action modes, cross-slot and unknown references, missing effect subjects, mixed representations, source mutation, canonical equivalence and valid-neighbor preservation. Verify means, factors and causes remain unchanged and instructions agree with the generated schema. Run relevant checks and check:fast before the producer commit and paid calls. Mechanical admission permits independent semantic review only; a source screen is not completed gameplay or the sixty-second objective.

## Evidence

[Decision 0215](../decisions/0215-use-canonical-targets-in-indexed-planning-screen.md) owns the alternatives. [Planning pipeline tests](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) own canonical equivalence and rejection evidence.
