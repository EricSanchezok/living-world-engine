# Observation intentions reported as realized results

Artifact-Version: 1

## Executive summary

A complete gameplay step passed its runtime validators while three model-rendered observations reported progress absent from the committed world. The external source review rejected the first commit. Successful request delivery and plan validation did not establish credible gameplay.

## Summary

The experiment retained forty-eight active actions and their complete contexts. All plans passed initial formal validation and runtime plan review. The resulting transition advanced ten seconds and maintained continuing activities, without events or other operations. Observation prose and apparent claims nevertheless asserted that a letter had been sent, a conversation had taken place, and an evacuation route had been cleared. The final causal reviewer accepted the candidate. Forty-five conservative pending projections made no such claims; three checkpoint observers used the model renderer.

## Timeline

- Native streaming delivered the complete planning, observation and verification calls without a new unresolved transport charge.
- The transition proposed continuing outcomes and a clock advance without realized events.
- The observation renderer used action descriptions to justify achieved-fact claims.
- The runtime committed a replay-consistent state; the full source review vetoed the commit and prevented the next step and confirmation run.

## Root cause

The observation system prompt listed action text alongside events, outcomes and facts as a source for concrete statements. Its internal evidence instruction repeated this ambiguity. Correct subject identity did not prevent the model from converting the subject's own future intention into a completed act. Reference and privacy validators check identity and access, not arbitrary predicate entailment; the final model reviewer was not a sufficient semantic guardrail.

A reached checkpoint caused the conservative pending projection to defer to the model. This exposed the defective prompt, but removing the checkpoint guard would suppress potentially legitimate new perceptions. An unchanged canonical world can still be newly observed. Similarly, continuing activity alone does not prove failed action semantics or require immediate completion of every long-running action.

## Guardrails

The [observation system contract](../../src/engine/prompts/system/observation-renderer.md) separates evidence for intent, occurrences, current appearance and uncertain claims. The [user instruction](../../src/engine/prompts/user/observation-renderer.md) preserves that distinction for both prose and apparent claims. Explicit outcome status and separate result evidence govern claims of sub-action realization. These instructions do not remove accessible facts, broaden deterministic projection, increase thinking or add a model call.

The existing [source review gate](../../src/engine/benchmarks/step-efficiency/trajectory-source-review.ts) remains mandatory for experimental gameplay acceptance. Prompt assets are validated through the registered prompt checks; actual behavioral qualification requires replaying the frozen failed requests and controlled counterfactual evidence. Passing engineering checks is not a claim that the prompt reliably prevents hallucinations. The experiment's unchanged-world progress and repeated context costs remain separate unresolved issues.
