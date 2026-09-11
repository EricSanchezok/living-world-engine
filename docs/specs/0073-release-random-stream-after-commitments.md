# Release the Random Stream After Commitments

Artifact-Version: 1
Status: Approved

## Intent

Remove observation and review latency from the ordered random critical section before introducing a final-candidate review barrier. The current component holds the stream until its complete resolution returns, although transition generation and repair cannot commit more randomness.

## Contract

The ordered Truth candidate owns a paired acquisition and completion capability. It acquires once before its first draw, retains ownership through every conditional commitment round, and completes exactly once after commitment generation closes, before transition generation. A component without draws inherits its predecessor's final state. Later transition, observation and review repairs retain the same committed checks, discrete results, receipts and local final RNG; they cannot reopen acquisition.

Independent components may proceed with their random commitments while an earlier component generates or reviews its transition. Any terminal failure still cancels pending work and rejects waiting gates through the existing atomic failure domain; publishing an RNG prefix is not a world commit. The speculative baseline is unchanged. No model stage or logical generation request is added to a successful run, and thinking, context, actions and repair allowances stay unchanged. Earlier independent work can already be active when a sibling fails; the existing drain must retain its usage and audit.

The candidate Composition pins `canonical-component-commitment-order-v2`. Old scheduling configurations are rejected rather than silently receiving different concurrency behavior. Historical evidence remains unchanged and no old trial or default instance is resumed.

## Plan

First reproduce the stalled later transition through the real SimulationEngine entry path with only the model provider boundary suspended. Move completion ownership from the component caller into the closed commitment stage, update candidate identity constructors, and verify canonical truth and replay against the serial reference. Run focused tests and check:fast before committing. Paid trials remain stopped.

## Verification

The existing canonical-stream regression must show that a second independent transition starts while the first provider response remains pending, with no repeated plan generation and the same checks, final RNG, canonical truth and replay as the serial reference. Injecting a terminal transport failure after the second transition starts must preserve the complete source state. Existing zero-draw, conditional-round, transition-repair and atomic cancellation regressions remain required. This establishes scheduling behavior at a substituted provider boundary, not live latency or cost improvement.

## Evidence

[Engine regression](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts), [stream regressions](../../src/engine/mechanics/__tests__/ordered-random-stream.test.ts) and [resolution repairs](../../src/engine/mechanics/__tests__/resolution-pipeline.test.ts) own verification. This refines the completion boundary of [decision 0105](../decisions/0105-order-random-consumption-without-resampling-plans.md) and prepares the [bound review stage](0072-bound-causal-review-stage.md); final global observation review integration remains separate.
