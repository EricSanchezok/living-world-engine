# Distinguish interaction context from boundary triggers

Artifact-Version: 1
Status: Approved

## Intent

Keep an occupied Agent's action running when another Activity's retained footprint is present only to constrain the current transition. Reduce repeated decisions and their model work without suppressing actual interactions, observations, causal checks or any original action.

## Contract

The complete action, Activity, Timer and Condition dependency closure remains available for component construction, context, conflict detection, source validation and continuation assertions. Retained `activity` nodes represent affected ongoing context; their audience membership alone does not trigger the post-boundary pause rule. Current `action` nodes and due `timer` or `condition` nodes retain that rule for authorized external observers. A due or resource-adjudicated Activity contributes through its actual action node. Existing onset reactions, explicit keep dispositions, interruption policy, continuation failure, world effects and observer authorization remain intact.

Candidate generation and CanonicalCommitter derive the same source class from independently validated dependency evidence. No model infers a replacement action or receives a new schema, prompt or extra call for this change. Execution contract 8 rejects older producer contracts; eager-reference version 22 and integrated player diagnostic version 5 identify the changed behavior. Old saves and experiment results are not migrated or rewritten.

## Plan

Reproduce unequal-checkpoint work through SimulationEngine and CanonicalCommitter with only the model boundary replaced. Keep a non-due external-audience Activity in the dependency closure while another Agent reaches a shorter checkpoint. Apply the source-class rule to both candidate and commit validation, retaining all other evidence. Record the choice in a decision and the escaped failure in a postmortem.

## Verification

The regression must fail on the old implementation because the continuing Agent is paused by retained context. It must then prove the original Activity and checkpoint persist, no replacement action or extra AgentMind is generated, and no synthetic outcome is added for the non-due Activity. Test actual later action-triggered interruption, due Timer and Condition influence, invalidated continuation assertions, and rejected forged pauses or altered context footprints. Run the relevant engine, temporal, participant and registry checks and complete check:fast before committing. Preserve source-bound full-world evidence and qualify any real model latency or gameplay benefit separately under the [player efficiency contract](0122-player-action-efficiency.md).

## Evidence

The [causal Activity contract](0005-causal-activity-interactions.md) owns the complete interaction closure and interruption protocol. The [temporal mechanics](../../src/engine/mechanics/temporal.ts), [reference algorithm](../../src/engine/algorithms/eager-reference/eager-reference.ts) and [CanonicalCommitter](../../src/engine/runtime/canonical-committer.ts) own the execution boundaries.
