# Explicit Physical Planning Worklist

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), expose the exact physical planning task without requiring the model to reconstruct its assigned action inventory from shared context deltas. Preserve complete background and source ownership.

## Contract

An opt-in request wrapper adds one source-bound planningWorklist member to the existing physical task. It copies every assigned action record in full, preserves source slot and action order, and indexes all target-eligible entity selectors with their exact handles, labels and allowed source slots. It does not infer relevant targets, paraphrase actions, add output responsibilities or delete any original context member. Differing labels remain distinct index records with their original slot membership.

The projection binds the complete original physical context hash and every reconstructed logical context hash. Recomputing it from the preserved source must produce exactly the same value. Unknown, duplicate or inconsistent ownership and repeated projection fail preparation. Existing shared-context binding, selector and canonical validation remain authoritative. Repair candidates and issues retain their original coordinates; singleton repair projects only its actual assigned actions and current permitted targets.

The wrapper changes neither output schema nor decoding, generation settings, batch cardinality, repair limits, runtime defaults or world APIs. It runs after existing physical representation wrappers, which have already annotated exact source choices. Its version binds the projection contract, content and static instruction. Model refusal or schema/semantic failure remains a recorded failure; no output filtering or nearest-choice correction is introduced.

## Plan

Verify source and target index completeness, exact full-record copying, scoped label differences, state and ownership hashes, unchanged output handling, and the real admission/repair path. Measure additive request bytes before freezing a complete-source prospective qualification. Keep historical failed trials immutable.

## Verification

Removing only task.planningWorklist must restore the original context exactly. Source mutation or projection corruption must fail the binding check. Test shared v2/v3 and singleton contexts, all original action counts, and valid neighboring slot retention through targeted repair. Run relevant tests and check:fast before committing. Report projection overhead and all paid calls; neither task layout nor formal admission establishes semantics, general reliability or gameplay.

## Evidence

[Decision 0132](../decisions/0132-project-explicit-planning-worklists.md) owns the rationale and research boundary. Frozen source-choice probes retain the raw assigned/available mismatch and complete request context. [0041](0041-source-bound-plan-choice-schema.md) owns enumerated wire choices.
