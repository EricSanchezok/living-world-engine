# Align activity progress and completion

Artifact-Version: 1
Status: Approved

## Intent

Repair the contradictory activity contract encountered by the real player path under the delegated [nonthinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md). Preserve complete actions and supported intermediate changes without turning checkpoints into completion certificates. The existing gameplay optimization authorization covers this repair and its prospective diagnostics.

## Contract

Fixed, rate and staged activities retain their trusted completion schedule. A still-active scheduled activity has a continuing outcome unless supported failure or blockage terminates it; a completed scheduled boundary requires a settled outcome. Goal and conditional activities have no predetermined completion time and can finish only through supported adjudication of the complete task. Ongoing work retains its explicit terminal-disposition contract. Every assigned action keeps exactly one outcome, including repairs.

Continuing is the status of the whole task, not a prohibition on all intermediate events or operations. Proposed interval effects use the existing typed operations, state assertions, cause validation, dependency reconciliation and bound causal review. Temporal context, complete source intent and authored rules remain available to that review. An identity fact, a clock witness or a model's claim of progress does not establish an arbitrary occurrence or justify an early final effect. No effect or outcome is synthesized, removed or relabelled to gain acceptance.

Current-interval receipts follow the [interval settlement contract](0134-settle-interval-resolution-effects.md), independently of whole-task completion. Only the existing engine settlement path can invoke receipt effects. Resource-queued actions remain unstarted and cannot be semantically adjudicated. Exact clock advancement, resource constraints, world revision atomicity and replay remain kernel-owned. The component validator does not classify all action-linked effects as completion effects merely because their source action remains active.

## Plan

Unify mode-specific instructions in the real transition prompt, remove the overbroad component effect veto, and retain temporal status guards and existing causal-review ownership. Bind the implementation and prompt versions in a new prospective trial; preserved historical requests and reports are unchanged. Verify controlled intermediate writes, events and independently rejected consequences before a new complete-world player run. Model-facing improvements require measured results before claims of lower cost or latency.

## Verification

Exercise the real loader, compiler, TruthEngine, committer and replay with a two-part scheduled action: reach an intermediate state, then remain occupied until the authored end. Verify actual intermediate placement/event, continued activity, unchanged completion time and consumed interval receipts. Reject early settled status, false state/time witnesses and a causal-review veto atomically. Retain goal/conditional completion, invalidation, shared-resource queue and receipt settlement regressions. Run relevant tests and check:fast before a local commit.

## Evidence

[Partial-activity regressions](../../src/engine/algorithms/eager-reference/__tests__/activity-partial-effects.test.ts) reproduce the rejected valid progress path and check the existing rejection boundaries. [Goal and conditional scenarios](../../src/engine/algorithms/eager-reference/__tests__/conditional-completion.test.ts) bind status to actual effects and replay. [Decision 0162](../decisions/0162-separate-task-completion-from-interval-effects.md) records the responsibility split; [postmortem 0110](../postmortems/0110-activity-progress-misclassified-as-completion.md) records the escaped conflict. Controlled model boundaries do not certify real-model semantic judgment or sub-minute player feedback.
