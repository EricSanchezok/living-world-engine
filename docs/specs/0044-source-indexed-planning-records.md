# Source Indexed Planning Records

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), reduce opaque identity copying and inconsistent effect subjects in complete physical planning batches using reversible source selections. Qualify the representation before any runtime promotion.

## Contract

The opt-in physical wrapper runs after the [worklist projection](0042-explicit-physical-planning-worklist.md). It annotates each complete original action with a zero-based actionIndex and each complete target-choice row with a zero-based targetIndex. Identical entity handles share a target index while their labels and source-slot memberships remain separate, unchanged rows. Source context and annotations are hash bound; removing only codec-owned annotations restores the exact prior context.

The model emits a flat plans array with actionIndex instead of actionRef and targetIndices instead of targetRefs. An effect emits targetPosition, selecting a position in that plan's own targetIndices. The decoder restores the exact original action handle, target selectors and effect subject handle. It does not choose a subject, add a target, copy an outcome between actions, infer an effect or repair an invalid selection. Every assigned action must occur exactly once. Extra, missing, duplicate and invalid action indices reject the physical response. Invalid target selections remain invalid while independent valid neighbors reach their existing slot validators. All other plan fields and canonical constraints remain authoritative.

The physical instruction consolidates the replaced worklist, source-choice, target-selector and flat-wrapper field instructions into one description of the indexed wire. Action-owned means-source selectors remain unchanged. Complete original context, action and target cardinality, model, disabled thinking, repair bounds, audit and budget accounting remain fixed. No native constraint support or schema enforcement is presumed. Existing runtime Compositions and world APIs remain unchanged until a separate reviewed promotion.

## Plan

Implement source binding, annotated context, indexed wire schema and reversible decoding. Reconstruct the latest failed full-world 45/3 roots from their original Ledger state, actions and preparation; freeze a prospective bounded qualification with all 48 actions and 232 target entities visible. Preserve old failures and do not count an offline re-encoding as model recovery.

## Verification

Exercise the complete existing dependent/factor/selector/flat/worklist pipeline through real canonical schema parsing. Verify canonical round trips, independent output order, singleton repair, scoped target permissions, repeated target references, empty target lists, unknown selections, altered snapshot/annotation rejection, stale repair indices and unchanged non-planning requests. Run relevant tests and check:fast before commit. Report full-root admission, repairs, actual HTTP, token, cache, latency and cost separately from source semantic review and committed gameplay.

## Evidence

[Decision 0134](../decisions/0134-index-planning-record-references.md) owns the representation rationale. [Postmortem 0073](../postmortems/0073-effect-target-declaration-feedback.md) owns the relational feedback failure and permanent diagnostic regression. Latest full-world evidence remains in the independent STEP-E2 Ledger and journal.
