# Bind plan causes to component scope

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

The full reference catalog includes visible actions outside the current Truth component. Its cause permission is not the complete stage-specific causal contract. A source-indexed plan selected such an action and passed catalog checks but failed the real materializer. Filtering only current assigned actions would instead remove valid component peers during targeted repair.

## Decision Drivers

Match the existing runtime causal domain, preserve repair evidence and full context, and avoid guessing eligibility from model prose or visibility.

## Considered Options

- Use all visible cause-authorized catalog actions.
- Limit every request to its current assigned output actions.
- Project the owning component's exact current commitment action set.

## Decision Outcome

Project the runtime set and use it to constrain indexed action-cause choices. Preserve the root component set across narrowed repair requests. Keep all visible actions in context and all existing materializer checks.

## Pros and Cons of the Options

Catalog-only admission includes actions the runtime rejects. Assignment-only admission loses legal peers during repair. An explicit runtime binding matches the authoritative set and preserves both boundaries, at the cost of another small versioned task field. It does not establish semantic relevance of the chosen evidence.

## Links

- [Component cause scope contract](../specs/0088-plan-cause-component-scope.md)
- [Indexed plan causes](0149-index-existing-plan-causes.md)
