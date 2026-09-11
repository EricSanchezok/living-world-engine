# Observation Actor Perspective Confusion

Artifact-Version: 1

## Executive summary

A valid observation envelope and local references did not ensure that the narrator was the assigned observer. A model could turn another actor's supplied outcome into a first-person memory. Source-bound semantic inspection vetoed the candidate before a new full-world request was sent.

## Summary

The source request `trajectory-e1-12-http-206` assigns Kinkaris as observer and supplies High Chief Cruk's action and outcome. In `probes-e1-shared-observation-fixed-01`, low-thinking responses 002 and 004, slot five, described Cruk's meeting as the observer's own act. Response 004 passed the finite schema/reference/old-state literal guard. The completed probe report hash is `e7bd9b7eafd3fb251d44ea421993b33bc6e560d508aacaa403830daf3e0c7934`. Its mechanical score remains historical evidence; it does not establish semantic eligibility.

## Timeline

The batch-prompt correction restored complete slot output. After the low-thinking candidate met its finite mechanical gate, inspection of the remaining reference failure exposed the wrong actor in the narrative. Inspection of the mechanically accepted repeat found the same error. Whole-game admission was withdrawn before trajectory 13 started, and the failure was retained as a counterexample for a new prospective probe.

## Root cause

The renderer receives adjudicated actions and an independently assigned observer. The prompt required truthful accessible observations but did not explicitly distinguish the narrator from the actor in the supplied outcome. The finite admission screen checked schema, references and protected literal values, which cannot establish attribution or perceptibility in arbitrary prose. Shared-context reconstruction preserved the original source and was not the cause of an identity remapping.

## Guardrails

The [observation role](../../src/engine/prompts/system/observation-renderer.md) binds the narrator to the supplied observer and distinguishes evidence from proof of participation or perception. It prohibits converting another actor's outcome to first-person action, retaining uncertainty when access is not established. The [user task](../../src/engine/prompts/user/observation-renderer.md) asks for this distinction before rendering outcomes. No input action, observer, state fact, reference or validator is removed or changed.

The [shared observation coordinator](../../src/engine/mechanics/truth-batch-provider.ts) places an identity table beside each physical slot. The table copies the observer reference and existing local handles, identifies existing self aliases through supplied canonical bindings, and partitions supplied action references by exact actor identity. It adds no semantic judgment about perception, selects no new reference, and does not rewrite output. The complete logical context remains reversibly encoded. The [coordinator regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) verifies separate self-action and other-actor slots, exact context reconstruction and unchanged singleton dispatch.

The [prompt regression](../../src/engine/prompts/prompts.test.ts) preserves the explicit distinction and counterexample. The STEP-E1 evidence requires a separately frozen probe and source-bound review of the known actor/observer mismatch before full-world admission. Literal and structural checks remain useful finite evidence, not semantic certification; any newly determined semantic violation vetoes promotion even if numerical development gates pass.
