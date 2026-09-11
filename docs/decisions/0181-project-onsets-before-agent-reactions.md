# Project Onsets Before Agent Reactions

## Status
Proposed
Class: architecture

## Context and Problem Statement

The eager preparation treats shared placement or an accessible entity-valued relation as sufficient onset perception and synthesizes a stimulus containing the source action's complete raw text. Conservative interaction footprints can therefore transfer unobservable intentions into another Agent's reaction context. Structural reference checks do not establish the meaning of a relation or the perceptibility of a private plan. The separate Truth routing path contains observer-local stimulus materialization, but the eager onset path bypasses it.

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

The proposed replacement uses the existing perception completion response to carry explicit observer-specific reports and stimuli. Engine-owned pair assignments and source-bound receipts connect these reports to frozen reactions. The [approved contract](../specs/0128-observer-bound-onset-receipts.md) owns implementation and empirical acceptance. This proposal is not evidence that the runtime replacement has shipped or that full-scene semantic qualification has succeeded.

## Pros and Cons of the Options

Generic wording removes detail needed for meaningful reactions while leaving false admission intact. A separate routing phase reuses established functionality but adds a serial model boundary. Integrating reports into perception preserves the semantic boundary with fewer phase transitions, but adds output work, changes the existing terminal contract and can reduce direct-reaction overlap. It still requires independent source review; valid references cannot certify observability.

## Links

- [Private reaction semantics](0037-agent-evolution-self-awareness-and-reaction-window.md).
- [Pre-boundary reactions](0073-stage-reactions-before-temporal-boundary-selection.md).
- [Epistemic planning for single- and multi-agent systems](https://doi.org/10.3166/jancl.21.9-34) distinguishes global actions and an Agent's local action view; it does not validate this engine's natural-language projection or latency.
