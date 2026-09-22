# Reaction Compilation Lost Introduced Identities

Artifact-Version: 1

## Executive summary

An Agent reacted to a newly perceived entity using the local identity the engine had just supplied. Replacement Action Compilation read an older private-state projection and rejected that valid identity. Replacement compilation needs the reacting Agent's frozen introductions in its disposable planning copy.

## Summary

STEP-E3 execution `3165739a-871b-4420-bdf4-853073b7a416` failed with `reference.projection_missing` after 87.858 seconds. Two reaction-local targets existed in the frozen stimulus, but neither existed in the planning state's Agent bindings. No world step was committed.

## Timeline

- Onset perception materialized new observer-local identities.
- AgentMind received those introductions and selected a replacement action using them.
- The compiler rebuilt its reference catalog from the earlier planning snapshot.
- Target projection failed before a replacement compilation request could be sent.
- A real prepare, serialize, restore and complete regression reproduced the same failure.

## Root cause

Reaction decision generation applied stimulus bindings to an Agent copy, while replacement compilation independently cloned the original planning state. Existing introduction tests kept the original action; target-domain tests stopped after generating a valid replacement. Neither crossed the subsequent compiler and atomic commit boundary.

## Guardrails

The [completion owner](../../src/engine/algorithms/eager-reference/eager-reference.ts) applies each replacement actor's own validated, frozen stimulus to that actor in the disposable planning state before compilation. It does not mutate the source or preparation, or share private bindings across Agents. The [onset isolation regression](../../src/engine/algorithms/eager-reference/__tests__/onset-isolation.test.ts) restores a serialized preparation, compiles the new target, commits and replays the resulting world, and verifies the binding belongs only to its observer.
