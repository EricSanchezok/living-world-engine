# Scoped plan repair batching

Artifact-Version: 1
Status: Approved

## Intent

Coalesce concurrently ready semantic plan repairs without repeating the complete world in separate physical requests. The continuing autonomous optimization authorization covers this opt-in experiment; it grants no additional model budget or semantic approval.

## Contract

The shared Truth batching child accepts an explicit `planRepairBatching: scoped-plans-v1` selection. It admits `truth_resolution_plan_repair` to the existing shared batch collector and uses the existing `truth_resolution_plan_commit_batch` wire schema: both logical schemas require the same commit_plans result. The original logical schema name, single-action responsibility, selected plan, complete context, issue list, previous candidate and catalog remain bound to each slot. Initial plan commits and repairs remain separate groups.

All existing profile, execution, revision, prompt, signal, scope-mode and repair boundaries remain in force. Each logical caller runs its original validation and materialization, replaces only its selected plan and retains its recovery limit. Valid neighboring slots are not regenerated merely because another slot fails. The collector retains the configured twelve-slot ceiling and ready-work scheduling; it does not wait for later reviews or add model calls. Singleton repairs retain their original request schema.

The option requires shared contexts and the physical request contract. Default and closed Compositions are unchanged. Different physical grouping is a new model-visible condition; offline equivalence cannot prove model semantic equivalence or improved gameplay. No weaker validation, omitted context, stronger thinking or altered action is permitted.

## Plan

Reproduce unbatched semantic repairs through the coordinator and a real registered game step. Freeze a recorded-input scheduling diagnostic after checks and a local commit. Keep original successful and failed requests immutable. Evaluate any paid integrated candidate with the existing budget, semantic review and gameplay gates.

## Verification

Compare independent repairs before and after selection for exact reconstructed contexts, per-action delivery, retained invalid-slot rejection, singleton behavior and boundary separation. Verify the selected registry configuration reaches actual TruthEngine repair calls, preserves committed world state and replay, and changes the physical call count. Run relevant tests and check:fast before committing. Report call coalescence separately from cache, tokens, actual latency, semantic failure and paid savings.

## Evidence

The [coordinator](../../src/engine/mechanics/truth-batch-provider.ts) owns physical delivery; [the TruthEngine](../../src/engine/mechanics/truth-engine.ts) retains targeted repair and materialization authority. [Decision 0148](../decisions/0148-coalesce-scoped-plan-repairs.md) records the tradeoff.
