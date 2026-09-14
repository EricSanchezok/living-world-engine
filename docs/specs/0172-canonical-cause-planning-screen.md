# Canonical Cause Planning Screen

Artifact-Version: 1
Status: Approved

## Intent

Isolate plan-cause reference spelling in the [complete-player experiment](0122-player-action-efficiency.md). Action-local means positions and global cause indices can denote different evidence at the same integer. The benchmark tests explicit cause references while preserving all other planning representations.

## Contract

A benchmark-only outer adapter changes ordered plan causeIndices to causeRefs. Each reference selects the exact existing cause row within the selected action's original slot. The complete source-bound cause table remains unchanged, including its action scope and every legal fact, event and law. No cause is selected, inferred, ranked, truncated, substituted or supplied by the adapter. Repetitions and order are preserved. The original cause decoder restores kind/ref pairs and retains canonical own-action, evidence, causality and semantic validation.

The generated schema replaces only the cause array field and shares the complete reference domain. The original user instruction and final contract tail are replaced consistently using their owning instruction accessors. Source context, canonical targets, action-local means, factor types, dependent fields, annotations, complete intentions, action coverage and all other fields remain unchanged. Unknown, cross-slot, missing and mixed references preserve rejected values and remain invalid; accepted neighbors remain intact. The adapter never repairs an invalid authored factor or chooses a means source from its explanation.

Source, domain, schema and instruction mutation fails closed. First planning, repair and physical batches use their current recorded domain. Ordinary calls and registered runtime Compositions remain unchanged. This screen changes no world execution or Truth resolution semantics.

## Plan

Reuse the complete indexed source-domain guard and restore cause indices before the existing decoder. Verify exact canonical equivalence through the whole planning pipeline and real model gateway with controlled HTTP. Replay preserved responses using reversible cause spelling only; retain their original outcomes. Freeze a checked producer and exact unchanged baseline before prospective paired calls.

## Verification

Cover ordered and repeated causes, all legal source kinds, unknown and cross-slot references, mixed forms, empty causes, invalid neighboring fields, action coverage, source/schema/instruction drift and valid-slot isolation. Verify that a missing own-action cause is not inserted and remains subject to the existing validator. Compare all other plan fields and complete context, and count the physical request tokens and calls. Run check:fast before the producer commit and paid calls. Mechanical admission and source screening do not establish completed gameplay or the sixty-second objective.

## Evidence

[Decision 0218](../decisions/0218-isolate-canonical-plan-cause-references.md) owns the alternatives. [Planning pipeline tests](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) own executable transport and rejection evidence.
