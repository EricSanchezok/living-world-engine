# Discriminate Perception by Temporal Route

## Status
Accepted
Class: testing

## Context and Problem Statement

An onset explanation can describe a witness returning later while declaring that the observer already receives the information. The [explicit assessment](../specs/0104-evidence-bound-perception-assessment-probe.md), [visibility instructions](../specs/0147-perception-visibility-branch-screen.md) and [semantic draft](../specs/0151-perception-semantic-draft-screen.md) already distinguish current access in prose; a separate verdict still permits this contradiction. A [source-bound receipt](../specs/0128-observer-bound-onset-receipts.md) validates identity and fixed checks without proving the occurrence of a natural-language information transfer.

## Decision Drivers

- Reduce an observed temporal information-flow error before reducing world evidence or action freedom.
- Preserve immediate direct perception, authored remote channels and meaningful pre-boundary reactions.
- Keep one model response and original canonical validation.
- Distinguish structural consistency from semantic correctness.

## Considered Options

- Add another current-versus-future instruction to the canonical discriminator.
- Require a new committed event for every perceived onset.
- Experiment with terminal route cases whose payloads determine current stimulus availability.

## Decision Outcome

The benchmark uses conditional terminal route cases. A pending relay has no stimulus field; current direct and established-channel cases retain the full original stimulus. The codec determines only the canonical tag implied by the selected case. The [specification](../specs/0157-temporal-route-perception-screen.md) owns exact behavior and qualification boundaries. Default execution remains unchanged.

## Pros and Cons of the Options

Another prose instruction leaves two independently generated, potentially inconsistent decisions. Requiring a committed event for every onset would exclude direct reactions before settlement and impose a different gameplay timing contract. Conditional cases remove one representational contradiction without an extra call or a new event system, but add output fields and still depend on correct model interpretation. A model can mislabel a future transfer as a current channel or direct perception; source review remains necessary. Pending does not mean the transfer will eventually succeed.

## Links

- [Lamport, Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf), partial-order definition and discussion on pages 558–559: sending and receipt are separate events, and the analysis concerns events that occur. This experiment applies that distinction as a representation hypothesis; it does not implement logical clocks or inherit a proof for natural-language perception.
- [Observer-local epistemic projection](0181-project-onsets-before-agent-reactions.md).
