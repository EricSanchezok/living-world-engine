# Bound Planning Relation Choices

Artifact-Version: 1
Status: Approved

## Intent

Reduce invalid planning combinations without selecting an action's meaning for the model. The delegated experiment authorization in [0029](0029-nonthinking-gameplay-efficiency-experiment.md) covers this separately configured candidate; complete gameplay acceptance remains unchanged.

## Contract

The physical indexed planning request derives complete relation menus from its exact visible canonical snapshot and each logical slot's reference permissions. Actor rating positions select only the assigned actor's ratings. Opposed difficulty selects a position in the plan's explicit target list and a rating owned by that target. Meter effects select a compatible meter and impact profile belonging to their explicit target. Condition effects select an authored condition/default-duration pair or an open semantic condition with any available authored duration. Empty menus remain empty; null ratings and open conditions retain their existing legality.

Encoding and decoding preserve all legal choices, plan and target order, prose, causes, factors, effects, declarations and optional fields. The decoder only restores exact selected relationships. It cannot infer a target, change an effect kind, supply a missing choice, delete a repeated fact assignment, or correct a semantic mismatch. Unknown, cross-slot, mixed-representation and changed-snapshot selections fail. Independent physical slots retain their own validation outcomes. Menus bind the current request; rejected selections retain the vocabulary needed for diagnosis when a repair changes scope.

This option composes with indexed causes, means, sparse arrays, planning tails, local mechanical repairs and catalog encoding. Existing first-batch cardinality, repair ceiling, raw HTTP evidence, full materialization, semantic review and atomic commit remain authoritative. A mechanically legal vitality effect does not establish the meaning of a reputation change. Default compositions do not enable the candidate. A paid experiment freezes a new configuration and protocol before dispatch.

## Plan

Add the relation codec after the existing indexed planning and optional tail transformations, register an explicit configuration, and exercise its full request/response path. Quantify the actual menu and wire cost on recorded complete inputs before a fresh non-thinking comparison.

## Verification

Round trip all available relation combinations, empty and null choices, open conditions, repeated targets, free text and optional fields. Reject wrong owners, incompatible meter definitions, missing targets, unavailable slot choices, ambiguous source bindings and snapshot/menu mutation. Exercise complete and narrowed repair requests through the real provider stack and preserve independent valid slots. Run relevant tests and the repository fast gate before committing; real model and full-world claims require separate evidence.

## Evidence

[Decision 0164](../decisions/0164-select-bound-planning-relations.md) owns alternatives. The [relation codec](../../src/engine/mechanics/planning-relation-choices.ts) owns menus and reversible selections; [regressions](../../src/engine/mechanics/__tests__/planning-relation-choices.test.ts) exercise the actual indexed pipeline. The existing TruthEngine materializer remains the final mechanical authority.
