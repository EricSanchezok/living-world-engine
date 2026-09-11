# Provisional Receipts and Action Completion

Artifact-Version: 1

## Executive summary

Transition inputs expose resolution receipts with an automatic full grade and an initially true settled flag even for a goal activity whose task is unfinished. The transition prompt said receipts constrain outcome status without explaining that settlement is derived again from the proposed outcomes. This obscured the distinction between adjudication grade and actual completion.

## Summary

A receipt grade determines the result of a settled action. It is not evidence that the action has already happened. At the transition-proposal stage, the engine defers receipt effects for continuing outcomes and validates completed outcomes against their grade and temporal evidence. The input flag may reflect initialization or an earlier rejected candidate.

## Timeline

- Receipt derivation initialized settlement before transition generation.
- A complete-world input included full, settled receipts alongside active compound goal activities with no scheduled completion time.
- Transition repairs also exhibited premature success descriptions; a separate representation diagnostic returned no outcomes.
- Inspection established the ambiguous stage contract but did not establish that it caused either model response.
- The transition prompt states the receipt's provisional meaning and retains all outcome, temporal and causal requirements.

## Root cause

The model-facing task treated receipts as status constraints without qualifying the stage of those constraints. The engine's [receipt derivation](../../src/engine/mechanics/resolution.ts) and [transition settlement](../../src/engine/mechanics/truth-engine.ts) implement distinct phases, but their distinction was absent from the prompt. Changing the canonical receipt default would affect other consumers; the correction describes the existing transition stage without changing grades, checks or application of effects.

## Guardrails

The [transition receipt contract](../../src/engine/prompts/shared/transition-receipt-stage.md) is included by the actual prompt bundle. The [runtime regression](../../src/engine/benchmarks/step-efficiency/transition-receipt-stage.test.ts) captures an initially full, settled receipt and verifies both a continuing goal with deferred settlement and an arrived goal with applied placement. It uses the real world loader, compiler materialization, Truth Engine and commit path with scripted model boundaries. Paid semantic reliability and the cause of empty model outputs remain unproven; historical failures retain their original status.
