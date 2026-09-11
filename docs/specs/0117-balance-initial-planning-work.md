# Balance initial planning work

Artifact-Version: 1
Status: Approved

## Intent

Test whether balancing complete conflict components across concurrent physical planning requests reduces the critical path to real player feedback. The user's continuing nonthinking gameplay experiment authorization covers this opt-in scheduling and cost tradeoff within the existing budget.

## Contract

The optional `planningPartition: "balanced-two-v1"` policy applies only to compatible initial `truth_resolution_plan_commit` requests in component scope. Each ready logical component remains indivisible. Its positive assigned-action count estimates work; the coordinator sorts components by descending count, breaking ties by the existing subject order, and assigns each to the least-loaded eligible group. It uses two groups when at least two components are ready, respects the existing maximum slots per physical request, and retains subject order inside each group. Singleton, global, repair, other-stage and missing-workload inputs retain the existing partition rule. The policy does not wait for extra components or change provider concurrency limits.

The registered shared-state-first batching configuration pins the policy in the recursive Composition. The default remains unchanged. Logical contexts, complete source actions, candidate scopes, snapshot identities, signals, schemas, source review, repair limits, ordered random commitments and atomic world commits retain their existing owners. Physical slot numbers are local to their request; responses and failures must map back to the exact original component. Requests with incompatible execution, profile, schema, scope or signal boundaries never merge.

This policy deliberately trades additional physical requests and duplicated shared input for potential latency reduction. Assigned-action counts are not measured model processing times. No theoretical scheduling bound or speedup follows from the partition alone. Freeze model, disabled thinking, source, order, sample count, budget and stop conditions before paid comparisons. Report actual HTTP, input/output/cache tokens, repair, mechanical admission, semantic evidence and elapsed time separately. Component admission does not establish complete gameplay; the full player-feedback goal and its confirmation remain required.

## Plan

Implement the partition at the existing coordinator's initial dispatch boundary and expose it through the registered experiment Composition. Exercise unequal complete components and real world execution with deterministic model substitution. Capture both actual request variants before a bounded fresh planning comparison; advance only supported behavior to a complete player-feedback trial.

## Verification

Test the 49-action, 11-component load shape without world-specific runtime rules. Prove exact logical context reconstruction, every action retained once, stable grouping under input reordering, concurrent dispatch, signal isolation, singleton handling, maximum cardinality, unchanged repair grouping and failure ownership. Through the registry and real SimulationEngine, compare committed canonical truth, Agent state, observations and replay; a failed sibling leaves the source uncommitted. Run relevant tests and `npm run check:fast` before the local commit.

## Evidence

- [Scheduling decision](../decisions/0168-balance-complete-planning-components.md)
- [Ongoing nonthinking experiment](0029-nonthinking-gameplay-efficiency-experiment.md)
- [Real player feedback acceptance](0108-measure-real-player-feedback.md)
- [Coordinator regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts)
