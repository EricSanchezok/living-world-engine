# Balance Ready Planning Waves

Artifact-Version: 1
Status: Approved

## Intent

Reduce the largest planning response on the [full player path](0122-player-action-efficiency.md) without increasing the number of initial physical requests or splitting a joint conflict component. The user's continuing authorization to change execution algorithms and run recorded experiments covers this opt-in scheduling policy.

## Contract

The `ready-wave-work-v1` policy collects the current ready promise wave at the existing post-promise dispatch boundary. Filling the slot ceiling does not dispatch an incomplete wave. No timer, future dependency or additional model result is awaited. Compatible requests retain the existing execution, profile, schema, repair and cancellation boundaries.

For initial component planning with positive assigned-action counts, the coordinator assigns whole components in descending work order to the least-loaded bin that has capacity. It creates exactly the minimum number of bins required by the existing slot ceiling. Subject order breaks ties and is retained within each physical request. Other stages, repairs and unsupported workload descriptions use the existing fixed partition. A logical component remains indivisible even when it dominates the work. No context, action, reference, validator, RNG commitment or world transaction is removed or reassigned.

This policy differs from the [two-group experiment](0117-balance-initial-planning-work.md): it cannot create an extra initial request merely to expose parallelism. Its scheduling estimate is assigned-action count, not a claim about model runtime. The incremental player diagnostic pins the policy in its Composition; production defaults remain unchanged. Old diagnostic saves retain their recorded producer and are not silently rebound.

## Plan

Extend the existing coordinator policy and registry validation, then pin it in the incremental diagnostic. Reproduce the recorded 49-action, 21-component shape before implementation and verify exact logical reconstruction. Freeze current code before a paired source-bound planning experiment and retain the full-player acceptance goal.

## Verification

Exercise the maximum-slot dispatch boundary, reversed input order, compatible work arriving in promise continuations, complete component coverage, capacity limits, minimum physical call count, malformed response ownership, and distinct execution and signal groups. Preserve existing repair and default-policy tests. Run the registered WorldHost incremental execution regression and check:fast before committing. Paid comparisons must preserve complete sources, count every actual request and failure, and review source semantics before promotion; shorter planning is not a completed player action.

## Evidence

[Decision 0224](../decisions/0224-balance-work-within-the-ready-wave.md) owns the alternatives. [Coordinator regressions](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) and [WorldHost integration](../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm.test.ts) own executable evidence.
