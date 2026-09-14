# Require Observed Interruption Evidence

## Status
Accepted
Class: architecture

## Context and Problem Statement

Current action audiences, like retained Activity footprints, are conservative dependency information. A current node does not establish perception: its paired onset report can explicitly say no stimulus. Intersecting that audience with the list of rendered observers still pauses uninformed characters because outcome coverage includes their own pending work.

## Decision Drivers

- Policy wakeups must follow authorized information rather than dependency membership.
- Real onset stimuli and witnessed external events must retain their effect.
- Ordinary self progress must not create repetitive replanning.
- Candidate generation and the transaction kernel must agree on validated evidence.
- The correction must not add inference calls or reduce semantic scope.

## Considered Options

- Retain the conservative current-audience rule.
- Use onset stimuli alone and ignore events arising at the later boundary.
- Keep onset decisions at preparation and derive later interruptions from observed external-event provenance after rendering.
- Add a separate model classifier for interruption relevance.

## Decision Outcome

Select the observed-evidence rule in [0165](../specs/0165-observed-activity-interruptions.md). Full dependency context remains available for conflicts and continuation validation. Onset receipts retain preparation authority; later observations can supply actual event provenance. Observation-triggered settlement is recomputed before causal review and policy cognition. The committer recomputes it from the same validated evidence and rejects temporal drift.

This supersedes the current-audience interruption rule in [0178](0178-separate-boundary-triggers-from-activity-context.md), while preserving its distinction between retained context and actual work. It extends the local-perception boundary of [0181](0181-project-onsets-before-agent-reactions.md) through completion instead of admitting a second implicit stimulus after preparation.

## Pros and Cons of the Options

Conservative current audiences are inexpensive but contradict explicit no-stimulus evidence. Onset-only interruption avoids that contradiction but misses perceived events from continuing Activities. Observed event provenance reuses existing validated data without another model request; it requires rendering before final interruption settlement and recomputation after repair. A relevance classifier can express additional judgments but adds latency and a new fallible authority where the existing event provenance already answers this narrower eligibility question.

## Links

- [Interruption contract](../specs/0165-observed-activity-interruptions.md).
- [Observer-bound onset receipts](../specs/0128-observer-bound-onset-receipts.md).
- [Reference producer](../../src/engine/algorithms/eager-reference/eager-reference.ts).
- [CanonicalCommitter](../../src/engine/runtime/canonical-committer.ts).
