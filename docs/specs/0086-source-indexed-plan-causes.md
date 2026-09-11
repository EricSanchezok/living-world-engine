# Source-indexed plan causes

Artifact-Version: 1
Status: Approved

## Intent

Let the planner select existing legal causal evidence without separately spelling its kind and reference. This opt-in experiment is covered by the continuing autonomous optimization authorization; it does not increase the model budget or establish semantic approval.

## Contract

The indexed reviewed planner accepts an optional source-indexed plan-cause contract. Its complete request-local catalog contributes every candidate authorized for cause use whose kind is action, event, fact or law. The projection retains each exact kind/ref pair, label and source slots; it does not rank, truncate, invent or select evidence. The original context stays intact. A plan emits ordered causeIndices instead of causes. Each explicit index restores exactly one original pair within that action's source slot. Duplicate selections retain their order and multiplicity. The original schema, action-cause requirement, pre-plan evidence checks and materializer remain authoritative.

Unknown, out-of-range, mixed-format and cross-slot selections remain invalid. A malformed cause in one plan must not corrupt or regenerate an independent valid neighboring slot. Repair uses the current source domain and carries the rejected domain as diagnostic evidence; old indices never silently bind to a different source. Singleton and shared initial/repair requests use the same contract. No source is automatically selected, no model text is rewritten, and no illegal entity cause is converted into a fact or action.

The optional contract is pinned in the Composition; defaults and historical snapshots remain unchanged. The current planning prompt also names the four cause kinds permitted by the canonical schema, replacing the obsolete seven-kind list. The representation changes model-visible choices, so round-trip equivalence is not evidence of semantic equivalence or gameplay success.

## Plan

Implement the optional projection at the existing indexed planning boundary, register its explicit configuration, and correct the canonical prompt vocabulary. Verify reconstruction and actual game-entry routing before freezing a recorded-input diagnostic. Retain closed evidence and require fresh source review before gameplay admission.

## Verification

Exercise the actual indexed planning pipeline and canonical slot validators. Check exact round trips across all four kinds, order and duplicates, mixed representations, unknown selections, source drift, repair reindexing and invalid-neighbor isolation. Verify registry wiring and run check:fast before a local commit. Freeze a complete recorded-input preflight on the committed code before any paid diagnostic. Report mechanical, semantic, cost and gameplay findings separately.

## Evidence

The [canonical schema](../../src/engine/contracts/llm-schemas.ts) and [TruthEngine](../../src/engine/mechanics/truth-engine.ts) own legal evidence and causal validity. [Decision 0149](../decisions/0149-index-existing-plan-causes.md) records the representation tradeoff.
