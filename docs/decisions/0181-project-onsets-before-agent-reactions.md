# Project Onsets Before Agent Reactions

## Status
Accepted
Class: architecture

## Context and Problem Statement

Shared placement, accessible entity relations and conservative interaction footprints identify possible interactions without establishing sensory access. Synthesizing a reaction stimulus from global action text can disclose unobservable intentions. Structural reference checks establish neither the meaning of a relation nor the perceptibility of a private plan. Onset admission therefore needs an observer-local semantic projection before Agent reasoning, with the information-flow failure documented in the [onset-routing postmortem](../postmortems/0128-onset-routing-broadcast-private-intentions.md).

## Decision Drivers

- Preserve open world semantics and the distinction between truth, beliefs and player knowledge.
- Keep reactions before the next positive temporal boundary.
- Retain authored remote perception and visible actions requiring no check.
- Avoid another model call for every observer or another permissive repair mechanism.
- Evaluate actual information flow and player outcomes independently of schema acceptance.

## Considered Options

- Keep the automatic route and replace the raw-text stimulus with generic wording.
- Reintroduce a separate perception-and-routing model phase.
- Include observer-specific reports in the existing perception completion response.

## Decision Outcome

The perception completion response carries explicit observer-specific reports and stimuli. Engine-owned pair assignments and source-bound receipts connect these reports to frozen reactions. Preparation and completion share a typed transcript; the CanonicalCommitter compares candidate receipts and requests against the kernel’s independently retained preparation. Component Truth resolution has a closed reaction window. The [approved contract](../specs/0128-observer-bound-onset-receipts.md) owns behavioral and empirical acceptance; structural receipt validation does not certify model perception semantics or full-scene performance.

## Pros and Cons of the Options

Generic wording removes detail needed for meaningful reactions while leaving false admission intact. A separate routing phase reuses established functionality but adds a serial model boundary. Integrating reports into perception preserves the semantic boundary with fewer phase transitions, but adds output work, changes the existing terminal contract and can reduce direct-reaction overlap. It still requires independent source review; valid references cannot certify observability.

## Links

- [Private reaction semantics](0037-agent-evolution-self-awareness-and-reaction-window.md).
- [Pre-boundary reactions](0073-stage-reactions-before-temporal-boundary-selection.md).
- [Epistemic planning for single- and multi-agent systems](https://doi.org/10.3166/jancl.21.9-34) distinguishes global actions and an Agent's local action view; it does not validate this engine's natural-language projection or latency.
