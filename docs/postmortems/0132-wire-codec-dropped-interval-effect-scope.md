# Wire codec dropped interval effect scope

Artifact-Version: 1

## Executive summary

The interval-settlement correction added a temporal restriction to the canonical resolution prompt. The dependent-fields adapter replaced that entire paragraph with its separate representation instruction, which lacked the restriction. The actual physical planning request therefore omitted the explicit requirement that receipt effects belong to the current interval, including when the Activity continues.

## Summary

Prompt versions changed and mechanical tests passed, but neither established what reached the model after all adapters. Current-interval receipts settle immediately, so their generation and review must both distinguish present consequences from future completion effects. The missing instruction was confirmed in the recorded complete 49-action HTTP body; that observation alone does not establish that it caused a particular generated effect.

## Timeline

- The interval-settlement implementation updated the canonical effect instruction and the plan-review boundary.
- Complete-source reconstruction showed changed prompt-version metadata but an unchanged physical planning body.
- Inspection of the dependent-fields replacement identified the omitted temporal clause.
- Two real gateway/coordinator cases failed when the actual transport body was required to retain that clause.
- The temporal scope became a shared prompt asset outside the representation replacement.

## Root cause

The same semantic responsibility lived in both canonical and wire representation paragraphs. Updating the canonical paragraph changed its version hash but did not update the text substituted by the adapter. Existing checks covered decoding, batch preservation, effect settlement and review; they did not assert the temporal responsibility at the generated transport boundary. The mismatch survived because structural and runtime checks could pass independently of model-visible instructions.

## Guardrails

[The shared effect scope](../../src/engine/prompts/shared/resolution-effect-scope.md) owns the temporal responsibility independently of field representation. The [prompt composition](../../src/engine/prompts/index.ts) includes it before the replaceable effect-field paragraph. [Actual gateway/coordinator coverage](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) verifies the restriction survives physical batching and representation adapters for valid and rejected outputs. [Interval settlement](../specs/0134-settle-interval-resolution-effects.md) and its original runtime regression remain authoritative; transport preservation does not replace live semantic review or qualify the full-player latency target.
