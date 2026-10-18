# Direct feedback for known response-processing failures

Artifact-Version: 1
Status: Approved

## Intent

Use the user's explicit request to optimize review costs and finish necessary play qualification to remove creative model work from a narrow, engine-owned processing status. Preserve natural narration for world events and semantic interpretation. This extends the recovery presentation boundary in [Spec 0184](0184-conversational-continuity-and-recovery.md), without changing world execution or cognition.

## Contract

- A fresh, unstarted recovery beat may publish a deterministic processing notice only when its focus resolves to an already known local entity and both new observations and delivered speech are empty. Existing published segments and attempts exclude this direct path.
- The notice identifies the supplied local focus and says only that response processing did not complete and established progress remains. It asserts no attempted speech, physical action, refusal, missing knowledge, unfinished player goal or instruction to repeat work.
- The notice uses the interface's processing-status language and the existing local name. It does not expose canonical bindings, private intention, technical causes or another subject's cognition.
- Save ordinary ordered narrative segments and local mentions, release the existing feedback window, and retain every underlying failure in the Ledger. Record zero model requests and no model producer. Presentation completion never upgrades the failed action to success.
- Unknown-focus recovery, clarification, participant semantic explanation, new observations and delivered speech retain their existing paths. Ordinary prose retains all six publication axes and its bounded continuation allowance.
- A terminal recovery fallback must explain the processing boundary even when an earlier prefix exists. Preserve that prefix exactly and avoid appending an identical notice twice. Old failed trials remain failed historical evidence.

## Plan

Share the factual recovery notice between direct publication and terminal fallback. Admit the direct path beside established dialogue in WorldHost. Exercise real persistent publication with model transport forbidden, then review the displayed notice and unchanged canonical state.

## Verification

Use the frozen late helper-recovery source from the full-world trial. A fresh isolated beat must publish the correct helper identity with no request, world advance, altered source, changed neighboring beat or fabricated producer. A terminal failed beat must append the missing notice after its original prefix without rewriting it. Cover unknown focus, clarification, new observations and speech as exclusions. Preserve replay and the existing ordered-publication behavior.

## Evidence

[Postmortem 0197](../postmortems/0197-recovery-attribution-and-unobservable-manner.md) records the incorrectly attributed helper failure, redundant repair and immutable-prefix limitation. The final qualification record belongs to the [world acceptance report](../../worlds/fanren/authoring/validation/full-world-acceptance.json); historical failed model outputs are not relabeled as successful generation.

The frozen known-helper source passes the actual persistent Host with model transport forbidden: one correctly attributed status segment, zero creative attempts, no model producer, unchanged source and canonical state, and unchanged original database and neighboring beats. Eligibility exclusions and the affected host cases pass locally. The terminal-prefix regression remains separately marked as a fallback; it does not qualify the historical generated recap.
