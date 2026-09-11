# Separate boundary triggers from Activity context

## Status
Accepted
Class: architecture

## Context and Problem Statement

An Activity footprint is conservative evidence about the records and audience that ongoing work may affect. The conflict graph retains that footprint when another interaction overlaps it, even if its owner has no action due at the current boundary. Treating its audience as a new external stimulus turns contextual inclusion into a policy wakeup and can interrupt work repeatedly without a new interaction from that owner.

## Decision Drivers

- Keep complete causal context and source-owned references.
- Preserve independent Activity checkpoints and avoid unsupported policy wakeups.
- Retain actual onset reactions, current interactions and invalidated premises.
- Enforce the distinction in the fixed committer as well as candidate generation.
- Add no inference, output fields or world-specific action categories.

## Considered Options

1. Derive automatic audience-triggered pauses from current action, Timer and Condition nodes, while retaining Activity nodes as context.
2. Treat every retained Activity audience as a new stimulus at every intersecting boundary.
3. Remove non-due Activities from the conflict graph and prompt context.
4. Add a model call to classify every proposed interruption.

## Decision Outcome

The automatic post-boundary audience rule uses current `action`, `timer` and `condition` dependency nodes. A retained `activity` node constrains settlement but does not independently emit a new stimulus. Due and resource-adjudicated Activities enter through their source action nodes; affected Activities remain in the full closure and receive continuation checks and dispositions. Onset reaction evidence, explicit keep decisions, temporal policies, canonical effects and observation permissions retain their authority.

Candidate generation and CanonicalCommitter apply this distinction to their validated dependency evidence. Execution contract 8 and the new producer identities reject earlier contracts without migration. This correction does not claim that every model-selected audience is semantically accurate, or that a current node alone proves task completion. Those properties require source-bound gameplay review.

The event-driven MPOMDP work by Messias, Spaan and Lima motivates distinguishing a detected event from a standing state description. Its assumptions include free team communication and non-simultaneous events; Living World Engine retains private cognition and jointly resolves simultaneous boundaries. This design borrows the distinction, not the paper's solver, complexity result or communication assumptions.

## Pros and Cons of the Options

1. Current node kinds already encode the difference between work being adjudicated and retained context. Using them preserves every dependency with no new model cost. It retains the existing conservative rule for current audiences rather than solving general semantic relevance.
2. All-footprint wakeups are simple but can repeatedly pause occupied Agents solely because the same context remains present.
3. Removing non-due context avoids those wakeups by also losing required conflicts, resource holders and continuation evidence.
4. A separate classifier could express richer relevance, but adds latency, repair and another fallible decision to an already deterministic source-class distinction.

## Links

- [Approved boundary-trigger contract](../specs/0124-distinguish-interaction-context-from-boundary-triggers.md).
- [Causal Activity interactions](0073-stage-reactions-before-temporal-boundary-selection.md).
- [Messias, Spaan and Lima, 2013: Asynchronous Execution in Multiagent POMDPs](https://st.ewi.tudelft.nl/~mtjspaan/publications/b2hd-Messias13msdm.html).
- [Reference producer](../../src/engine/algorithms/eager-reference/eager-reference.ts) and [CanonicalCommitter](../../src/engine/runtime/canonical-committer.ts).
