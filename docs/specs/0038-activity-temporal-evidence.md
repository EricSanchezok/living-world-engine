# Activity Temporal Evidence Experiment

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), test whether explicitly supplying existing activity execution state prevents outcomes outside the current interval. Complete action prose and world context remain available. This addresses a missing model input, not a license to replace open actions with predetermined outcomes.

## Contract

An opt-in Truth setting supplies the same source-bound temporal evidence to planning, transition generation, plan review and causal review. It contains the current interval with catalog handles for due activities, timers and conditions; each visible activity's selected temporal profile and basis, scheduling state, progress, stages, continuation assertions and resource claims; and a hash binding the source values. Scheduled, paused, queued, ready and terminal states stay distinguishable. A checkpoint is not completion, null completion time is not immediate completion, and an unmet goal is not satisfied by elapsed time alone.

Projection copies exact engine values and converts references through the existing resolver. It does not evaluate arbitrary text into a new guard, select an effect, change duration or infer completion. The model can describe supported partial effects during an interval; the evidence does not impose universal no-effect behavior until a checkpoint. Unknown reference bindings fail instead of dropping records. Original context fields, action assignments, legal candidates, recovery limits and deterministic validation remain unchanged. A scoped context includes only its already-visible activities. Full-context caching cannot mix enabled and disabled evidence.

The experimental field is separate from the cached canonical projection. The original boundary remains present; the new handle projection makes the same identities joinable to the existing catalog and activity records. Existing runtime defaults remain disabled until source-bound experiments and semantic checks support promotion. No game API or saved-world contract changes.

## Plan

Implement and verify the projection and its opt-in builder wiring. Bind source activity and boundary values in free replay before freezing a paid comparison. Review luring without invented injury, scouting within available time, waiting, rate progress, interruptions and queued work against source facts. Preserve failed trials and account for all new calls in the existing ledger.

## Verification

Use the real world loader and temporal materializer to distinguish an early interval from a checkpoint and a completed fixed/rate action. Verify exact progress, stage, assertion, queued/reserved state and reference projection, unchanged source objects, missing-reference rejection and builder cache isolation. Verify plan and causal review receive the same temporal snapshot. Run relevant tests and check:fast before committing. Mechanical input completeness does not establish semantic success or continuous gameplay.

## Evidence

[Decision 0128](../decisions/0128-supply-activity-execution-evidence.md) owns the tradeoffs. The experiment's local evidence index owns captured source and prospective trial results.
