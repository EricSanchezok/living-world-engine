# Cover Condition Creation with Subject Scopes

## Status

Accepted
Class: architecture

## Context and Problem Statement

Action grounding can reference only existing canonical objects. A trusted resolution effect can allocate a new condition after grounding. Requiring its exact ID in the earlier declaration makes ordinary local creation exceed its dependencies and forces global readjudication. Simply ignoring unknown condition writes would lose cross-component conflict protection.

## Decision Drivers

- Preserve future record identity ownership in the kernel.
- Reuse the declared affected subject without another model call.
- Detect readers of a subject's condition state, including readers with no physical delta.
- Retain exact-key protection for overwriting existing records.

## Considered Options

- Keep mandatory global readjudication for every new condition.
- Ignore fresh condition keys during dependency validation.
- Cover creation by an explicit subject write and validate conservative subject scopes at merge.
- Add a new predicate language and rebuild all dependency graphs around it.

## Decision Outcome

Use explicit subject writes to cover fresh condition creation, paired with late subject-scope collision checks against both declared and actual accesses. The [contract](../specs/0154-subject-scoped-condition-creation.md) defines the admitted creation and rejection boundaries. This is a bounded use of logical access scopes, not an implementation of arbitrary database predicate locks or a proof of model dependency completeness.

## Pros and Cons of the Options

Mandatory global execution preserves the conservative boundary but repeats unrelated semantic work and can exceed model capacity. Ignoring fresh keys has no protection for overlapping interpretations. Subject scopes support local creation while rejecting potential same-subject interference, at the cost of conservative fallback for some disjoint condition accesses. A full predicate language could distinguish those accesses more precisely but would expand model and runtime contracts before the observed narrow failure is resolved.

## Links

- [Dependency validator](../../src/engine/mechanics/action-dependency.ts)
- [Grounding contract](../../src/engine/prompts/system/action-grounding.md)
- [Eswaran et al., logical subsets and predicate locks](https://research.ibm.com/publications/the-notions-of-consistency-and-predicate-locks-in-a-database-system)
