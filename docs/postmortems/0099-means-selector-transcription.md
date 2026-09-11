# Means selector transcription failure

Artifact-Version: 1

## Executive summary

A complete plan batch failed because one means selector transposed characters in its hashed identifier. The model's emitted string was absent from every permitted inventory. Action-local integer positions offer an explicit source selection with less transcription burden, while the existing reference and grounding checks remain strict.

## Summary

A two-root diagnostic returned all forty-eight plans. Every selected cause was in the correct source slot and included the plan's own action. One means in the thirty-four-action root used an unknown hashed selector; the fourteen-action root passed formal validation. The group was not admitted to gameplay, and no fuzzy correction reclassified the failed output.

## Timeline

- A complete action-owned inventory exposed exact hashed means selectors.
- The model returned one unknown selector resembling an existing fact selector.
- The decoder and canonical schema rejected the affected plan.
- The source comparison retained the typo as failed evidence, and an optional local-position representation was implemented and tested.

## Root cause

An opaque identifier required exact model transcription even though its owning action already contained the complete ordered choice list. The near match is evidence of a transcription-like error, not permission to infer or repair the intended fact. Other incorrect semantic choices remain possible with integer positions.

## Guardrails

The [indexed planning regressions](../../src/engine/mechanics/__tests__/source-indexed-planning.test.ts) preserve rejection of unknown historical selectors, invalid positions and mixed formats while retaining valid neighboring slots. They verify exact reconstruction of descriptions, order and repeated choices. The [registered game-entry test](../../scripts/operations/step-plan-cause-choices.test.ts) verifies the opt-in [contract](../specs/0087-action-local-means-indices.md) reaches the physical model boundary; paid semantic and gameplay evidence remains separate.
