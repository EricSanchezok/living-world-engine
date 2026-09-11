# Invalid Causality Rendered Before Rejection

Artifact-Version: 1

## Executive summary

A transition with deterministically false operation assertions reached observation rendering before the causal validator rejected it. This made invalid candidates eligible to consume additional model calls before repair, even though the rejection required no model judgment.

## Summary

The STEP-E2 controlled conditional-completion trial returned 18 priced transition responses. Both arms failed the arrival and invalidated-target cases at the first candidate. Offline replay of saved responses isolated operation preconditions referring to a future clock or the operation's own destination, alongside a separate receipt-status mismatch. The final surfaced error was the experiment's prohibition on paid repair; that cap was not the original validation cause. The controlled trial used scripted surrounding roles and therefore does not measure the real observation charges avoided by the fix.

## Timeline

The trial froze three authored world scenarios and exercised the real simulation, compiler materialization, committer and replay paths while replacing only transition model responses with actual non-thinking DeepSeek calls. Saved responses 007, 008 and 014 reproduced false operation assertions without further model requests. An execution regression then demonstrated one observation-renderer invocation before each rejected causal candidate reached repair. Moving causal evaluation before rendering reduced that invocation count to zero while retaining valid-candidate rendering, bounded repair and canonical replay.

## Root cause

TruthEngine materialized trusted mechanic effects and the final clock advance, rendered observations, and only then evaluated proposal causality. An earlier outcome-coverage precheck protected missing and duplicated actions but did not cover false operation assertions. Success-path tests checked the final committed state; they did not constrain model work performed before deterministic rejection.

The same investigation identified ambiguous model-facing assertion timing, which requires its own frozen experiment. Operation assertions use sequential pre-operation state, mechanic invocation assertions use original input state, and event/outcome assertions use final post-operation state. This ordering fix does not redefine those semantics or claim to improve the model's initial output.

A subsequent assertion-timing trial also reproduced outcome statuses contradicting their committed resolution receipts. The envelope validator combined pure effect checks with observation evidence checks, leaving receipt, reference and identity rejection after rendering. Separating these phases moves effect-envelope validation before model observation work while preserving the observation-dependent checks afterward. A receipt-status mutant reproduced one premature rendering call before this follow-up fix and zero afterward.

## Guardrails

The [real execution regression](../../src/engine/mechanics/__tests__/transition-validation.test.ts) covers missing and duplicate outcomes, a premature operation clock, an operation requiring its own destination, and a receipt-status contradiction. It requires zero observation rendering before repair, rendering after a valid candidate, no leaked rejected placement, and canonical replay equality. The [causal evaluator](../../src/engine/mechanics/causality.ts) owns the cloned sequential working state; [TruthEngine](../../src/engine/mechanics/truth-engine.ts) invokes it and effect-envelope validation before observation rendering while retaining observation-dependent evidence and proposal checks afterward. Observation repair still revalidates both phases. The [experiment contract](../specs/0029-nonthinking-gameplay-efficiency-experiment.md) requires separate reporting of deterministic savings, model success and full-game acceptance.
