# Separate task completion from interval effects

## Status
Accepted
Class: bug-fix

## Context and Problem Statement

An activity can produce a supported intermediate consequence while its full task remains unfinished. Treating every operation or event citing an active action as a completion effect makes valid multi-part tasks impossible and conflicts with the supplied activity-evidence contract. Requiring a predetermined completion time also contradicts the goal-directed activity model.

## Decision Drivers

- Preserve arbitrary complete tasks, interval evidence and script-owned timing.
- Keep trusted receipt effects deferred and world commits atomic.
- Distinguish deterministic status constraints from open semantic effect review.

## Considered Options

- Forbid every effect linked to a continuing action.
- Declare completion, remove effects or split the source task to satisfy the veto.
- Keep mode-specific completion and receipt guards, and validate interval effects through the existing causal pipeline.

## Decision Outcome

The component validator enforces temporal outcome status and leaves interval effects to typed state validation, dependency reconciliation and the existing bound causal review. A continuing receipt does not apply its effects. Source actions, proposed consequences and world scope remain intact. Transition instructions distinguish scheduled completion from goal/conditional adjudication and ongoing work.

This repairs the overbroad veto without asserting that automated semantic review is complete. A model can still propose an unsupported consequence with true but irrelevant assertions; prospective source-bound testing must reject those cases before gameplay acceptance.

## Pros and Cons of the Options

- A blanket veto deterministically excludes premature effects but also excludes every legitimate intermediate write and occurrence, preventing active worlds from progressing through compound tasks.
- Forced completion, deletion or task splitting hides the failure by changing action meaning and can introduce extra calls or unsupported success.
- Existing causal validation preserves supported progress and existing mechanical authority. Open semantic entailment remains a model responsibility with explicit evaluation limits, rather than being replaced by an incorrect status heuristic.

## Links

- [Activity contract repair](../specs/0109-align-activity-progress-and-completion.md)
- [Goal-directed activities](0116-goal-directed-temporal-activities.md)
- [Activity execution evidence](0128-supply-activity-execution-evidence.md)
- [Interval evidence contract](../specs/0038-activity-temporal-evidence.md)
