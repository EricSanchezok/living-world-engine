# Repair Reference Witness Screen

Artifact-Version: 1
Status: Approved

## Intent

Test a source-bound repair layout under the [complete-player experiment](0122-player-action-efficiency.md). A canonical-reference screen still produced effects whose target and selected meter had different owners. Existing diagnostics describe the rejected target, while the repaired target can differ. The complete source already contains the relevant ownership records.

## Contract

A benchmark-only singleton planning repair adapter repeats exact canonical records for entity, meter and rating handles occurring as complete string values in the rejected candidate. It also includes the actual entity owners of selected meters and ratings. For every included existing entity, an exact join lists all its meters and ratings from the complete canonical source, including empty lists. Unknown references remain explicitly unknown. Occurrence paths, source context hash and candidate hash bind the view to its origin; text fragments are not parsed for identities.

The source context, output schema, preprocessing, validators, action count, repair count and output choices remain unchanged. The table is not a permitted-target shortlist, a repair instruction inferred from world lore, or a guarantee of semantic relevance. The model still chooses subjects and effects. The adapter adds an external instruction and the table after the schema through the existing JSON-object postlude, rejecting occupied postludes and unsupported source shapes. It does not register a production Composition or modify canonical data.

## Plan

Keep the adapter in the benchmark layer and apply it only to the physical canonical singleton repair path. Compare the same immutable failed planning candidate with and without the postlude. Complete source and physical request captures precede fresh paid calls; the initial historical candidate is explicitly non-billable. Preserve failed trials without resampling.

## Verification

Test exact records, complete ownership joins and empty domains, unknown references, source immutability, unchanged schema and preprocessing, and real SimulationEngine repair followed by canonical commit and replay. Before new model calls, reproduce baseline physical requests and replay historical outputs through both arms with identical mechanical results and canonical plans. Freeze a fixed paired trial with complete transport accounting. Mechanical admission does not qualify whole-plan meaning or the sixty-second player objective.

## Evidence

[Decision 0213](../decisions/0213-repeat-exact-repair-reference-witnesses.md) owns the alternatives. [Adapter tests](../../src/engine/benchmarks/step-efficiency/repair-reference-witness.test.ts) own the source and real-entry checks.
