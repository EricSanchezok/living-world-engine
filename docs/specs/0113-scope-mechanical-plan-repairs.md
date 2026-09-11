# Scoped Mechanical Plan Repairs

Artifact-Version: 1
Status: Approved

## Intent

Reduce repeated plan generation when deterministic validation identifies a strict subset of a complete joint candidate. The experiment authorization in [0029](0029-nonthinking-gameplay-efficiency-experiment.md) covers this separately configured candidate; gameplay acceptance remains unchanged.

## Contract

The first request retains the full logical action batch. A repair may request replacements only when the latest rejected output passes the current directive schema, covers every original action exactly once, has unique proposal keys, and every issue identifies an in-range original plan ordinal. Missing, ambiguous, unscoped, or all-plan failures retain complete-candidate recovery. No action is selected through text similarity or inferred intent.

The repair retains the complete rejected candidate and complete available action/world evidence. It binds the original source snapshot, previous candidate hash, selected action references and original ordinals. Selection includes the transitive declaration/reference dependencies of affected plans; a closure covering the full batch uses complete recovery. The model returns exactly the selected replacements. Assembly preserves every unselected draft and original ordering, then invokes complete normalization, the original full materializer, check construction and semantic review. Cross-plan constraints are rechecked; retained drafts are not treated as reviewed or committed. No mode, effect, actor, reference or action text is repaired by program inference.

The existing repair ceiling, cancellation, transport accounting, raw-response evidence and atomic commitment apply. Each invocation exposes its actual projected responsibility; reconstruction has separate evidence from provider normalization. A changed source snapshot stops the operation. Invalid replacement coverage cannot masquerade as a complete output. The option is disabled in existing compositions and requires a new frozen configuration for a paid comparison.

A marked mechanical replacement remains part of its original uncommitted component for physical batching. It may share a factored request with complete component recovery only when the existing profile, prompt, schema, snapshot, execution, cancellation and repair boundaries also match. Every exact slot context, including its distinct scope and rejected candidate, survives the reversible envelope. Unmarked or unknown replacement contracts retain ordinary mode separation; first requests and semantic plan-repair stages retain their existing boundaries and root slot limit.

## Plan

Add deterministic selection and reconstruction at the logical planning boundary, preserve downstream wire codecs and batching, exercise real execution and rejection paths, then freeze a same-input comparison before admitting the candidate to full-world runs.

## Verification

Verify initial full coverage, strict replacement ownership, unchanged retained drafts, original ordering and snapshot binding. Through the real engine, diagnose one invalid plan, repair only that plan, jointly validate the complete result and verify committed state plus replay. Reject a replacement that creates a conflict with a retained plan, preserve rollback on exhaustion, and verify malformed or unlocalized candidates use complete repair. Include the indexed physical batching path and run the repository fast gate before committing.

Exercise mixed local and complete component recovery through the real batch coordinator: one compatible physical request must reconstruct both original logical contexts exactly, while unmarked and unknown contracts remain separate. Replay a recorded full-world first response with identical index domains to check that narrower repair responsibilities do not add a transport group.

## Evidence

[Decision 0163](../decisions/0163-reconstruct-joint-plans-after-local-repair.md) records the alternatives. The [repair implementation](../../src/engine/mechanics/mechanical-plan-repair.ts) owns selection and reconstruction; the original full materializer in [TruthEngine](../../src/engine/mechanics/truth-engine.ts) remains authoritative. [Runtime and dependency regressions](../../src/engine/mechanics/__tests__/mechanical-plan-repair.test.ts) exercise the configured candidate, baseline, rollback, replay and indexed physical boundary. [Postmortem 0114](../postmortems/0114-component-wide-mechanical-plan-regeneration.md) records the escaped failure.
