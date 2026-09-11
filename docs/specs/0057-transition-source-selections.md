# Transition Source Selections

Artifact-Version: 1
Status: Approved

## Intent

Within the delegated [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md), simplify the unpromoted [interval assessment](0055-transition-current-interval.md) without weakening original-action or state-effect checks. [Decision 0137](../decisions/0137-select-transition-source-evidence.md) owns the representation tradeoff.

## Contract

Gate evidence consists of model-selected JSON Pointers into the same complete, immutable source used by the assessment. Every pointer must resolve within the existing permitted roots; unknown paths, inherited properties, malformed escapes and invalid array indices fail. The source value is read mechanically, never generated, amended or treated as proof that the model's requirement follows from it. The wire rejects copied observed values rather than correcting them.

Unfinished work is selected as ordered, nonoverlapping inclusive source ranges over the lossless punctuation segments. Each range retains every original character between its first and last indices. The wire has no free-text pending-work plan. Selection can still omit relevant work, so completeness and condition preservation remain independent review obligations. Gates and source selections remain local request/response evidence. Only model-authored currentWork restores the canonical summary; operations, causes, assertions and other effects remain unchanged.

The current-work instruction binds first-person actions to the original actor and committed canonical participant identities. It distinguishes delegated work from personally performed work and current progress from later conditional work. These instructions do not establish deterministic semantic correctness. Preserve full source state, action and logical-batch cardinality, model, disabled thinking, generation settings, budget accounting and bounded recovery. Do not admit old responses through compatibility or inferred field completion.

## Plan

Freeze a fresh twelve-slot/forty-three-action diagnostic with at most two actual HTTP requests after verification and commit. Compare output burden and formal coverage with the closed source-matched diagnostic, then independently inspect actual work and retained conditions before gameplay promotion. The bundled representation change cannot identify each component's individual contribution. An unmet formal or semantic gate stops that trial and retains its charges.

## Verification

Exercise exact source range expansion including negation, punctuation, quantities and Unicode; reject invalid, reversed and overlapping ranges. Verify complete scoped pointer resolution, including null and nested values, without accepting generated values or foreign evidence. Retain gateway coverage for rejected neighbors and canonical output preservation. Run complete-request token admission and check:fast before the local commit.

## Evidence

[Interval assessment tests](../../src/engine/mechanics/__tests__/transition-interval-assessment.test.ts) own source binding and rejection. [Worklist gateway tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) exercise the actual request adapter and retained logical neighbors. Raw diagnostic artifacts and source reviews remain in the independent experiment evidence root.
