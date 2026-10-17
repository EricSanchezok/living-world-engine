# Delivered quotation lost its provenance during publication

Artifact-Version: 1

## Executive summary

A narrative consisting of an exact delivered-speech reference was rejected as a new action or commitment. Rendering had replaced the reference with plain quotation text before publication checking. The checker retained the original scene but had to infer the quotation's provenance again. The renderer now carries ordered narration and resolved-speech parts alongside the complete paragraph; all six factual checks remain mandatory.

## Summary

Night City's editor opening reached a real delivered reply about a screening deadline and review conditions. Creation returned only `[[speech-9264c75e56266e1e]]`. Publication invocation `d3723481-63eb-48b0-af1e-28dde117ef2f::rt:model-audit:97cebbb8943f764dd71254dcefe880c5ca7e05e87eecb912a4cc78a689140f49`, within execution sequences 1941–2176, classified its agency axis as a contradiction while the other five axes were grounded. The reply was already in the frozen participant scene; it was not a new transaction or the player's decision.

The repair execution `1909923e-95e5-4ac0-a80b-efd53e963ce8`, sequences 2177–2470, added an unsupported assertion that the speaker had not left a doorway. Its rejection was correct. The factual fallback preserved the actually delivered speech. Neither rejection rolled back truth or created a payment, authorization or completed review.

## Timeline

- On 2026-10-17, the real opening runner stopped on the narrative fallback. Ledger inspection identified the original marker draft and the two different publication judgments.
- Adding a visible speaker label alone did not reliably remove the erroneous agency judgment.
- A three-call agency-focus clarification accepted both valid quotation variants but also accepted the unsupported doorway assertion. That candidate was rejected.
- A separate three-call comparison retained each complete paragraph, scene, six axes, schema, profile and inference setting. It added ordered parts reconstructed from the recorded marker drafts. Both valid quotations were grounded; the doorway assertion remained rejected on material and agency. Each call dispatched once, without repair. This is evidence for these three recorded cases, not a general accuracy guarantee.
- The production renderer and continuation path gained the same provenance representation, with gateway tests for attributed speech, unsupported surrounding prose, literal quotation, duplicate references and partial-prefix trimming.

## Root cause

The creation boundary distinguished an engine-resolved speech reference from authored narration. Rendering erased that distinction before the independent publication decision. The common instruction that claims remain attributed did not establish which exact words had come from a resolved reference. Plans inside a genuine quotation could therefore be treated as new executed actions.

Existing tests checked exact rendered text, dialogue order, multiplicity and the presence of six publication axes. They did not preserve a code-owned distinction between quoted testimony and the prose around it. A broader permissive instruction obscured this distinction further, explaining why a valid-quotation-only test would have missed the negative case.

## Guardrails

- [Publication rendering tests](../../src/server/__tests__/world-narrative.test.ts) exercise rendering through the real decision Gateway. Only resolved references receive speech provenance; literal matching text stays narration. Unsupported surrounding action still enters all six checks and can reject the paragraph.
- [The renderer and continuation](../../src/server/narrative/publication.ts) preserve complete text and ordered parts together. Annotation-adjacent echoes are normalized without rewriting delivered utterances. A continuation that cuts inside a quotation treats the remaining fragment as narration.
- [The publication contract](../game-design/narrative.md#frozen-scenes-and-ordered-prose) keeps exact speech, truth, player agency and readable references separate. Provenance does not certify a speaker's claim or bypass grounding, order, multiplicity or completeness checks.

Future prompt changes must retain a negative case containing unsupported prose outside a valid quote. A successful positive quote alone cannot justify relaxing publication checks.
