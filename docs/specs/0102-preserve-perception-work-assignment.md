# Preserve perception work assignment

Artifact-Version: 1
Status: Approved

## Intent

Carry the onset scheduler's existing observer/source-action work assignment into the perception request under the continuing autonomous gameplay optimization authorization. The model must not reconstruct that work assignment from every possible relationship in the world. This repairs missing task information without reducing the action set or declaring that a candidate can perceive anything.

## Contract

When the scheduler requests perception for reaction candidates lacking an existing direct basis, it supplies each exact observer Agent and triggering action in the scheduler's order. The perception context exposes their existing entity/action handles as task assignment, preserving all existing action, state, dependency and catalog content. An assignment is a question about possible perception, not proof of sensory access, visibility, difficulty or reaction eligibility after a check.

Assignments persist unchanged during repair and committed-check continuation. Unknown or inactive observers, missing source actions, self-triggering pairs and duplicate pairs are invalid task inputs and fail before model HTTP. An absent focused assignment retains the general Truth stage's existing complete-action scope; an explicit empty assignment remains distinguishable. These are task scopes within one perception implementation, not alternative algorithms.

The model retains free check stakes, targets, evidence selection and the existing request/continue/completion protocol. The caller's direct-reaction partition, original intents, random stream, schema, repair bounds, model settings, canonical commits and cognitive boundaries remain unchanged. No assignment is converted automatically into a successful check, and no output or source context is rewritten. Numeric difficulty and semantic completeness require separate verification; this contract does not certify them.

## Plan

Add a typed optional focused assignment to the existing perception capability. Project it through the shared context builder using the current reference resolver, and pass the scheduler's already computed candidates. Keep other Truth stages free of this assignment. Explain its meaning in the perception prompt.

## Verification

Exercise the real perception entry with valid, empty and invalid assignments; verify complete context equality after removing only the added task field, exact order and identity across repair and continuation, and rejection before HTTP without state/RNG mutation. Exercise the real engine step to prove the scheduler forwards the intended observer/action pairs and that reaction still requires a successful committed perception check. Run focused tests and check:fast before committing. Freeze explicit positive and negative perception controls before real-model validation.

## Evidence

[Perception entry regressions](../../src/engine/mechanics/__tests__/perception-references.test.ts) cover request identity and evidence preservation. [Engine step regressions](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) cover the scheduler-to-perception-to-reaction path. The [incident report](../postmortems/0106-perception-stage-instruction-conflict.md) records the observed task-information gap.
