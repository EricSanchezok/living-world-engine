# Compose reviewed truth transport for playtests

## Status
Accepted
Class: feature

## Context and Problem Statement

Source-bound planning can pass while the game still selects an older request representation. A practical full-world test must use the intended codec, layout and parser through a registered, auditable Composition rather than an unrecorded gateway override.

## Decision Drivers

- Exercise the actual engine and preserve historical producer identities.
- Keep complete inputs, action freedom and disabled-thinking model settings.
- Avoid claiming broad reliability from development-root evidence.

## Considered Options

- Promote the candidate as the game default immediately.
- Inject request policies only in the experiment's gateway.
- Register an explicit candidate batching Composition and select it only for a gated fresh playtest.

## Decision Outcome

Select the explicit candidate in [0034](../specs/0034-reviewed-truth-transport-playtest.md). The registered coordinator shares its request-policy implementation with source admission. Configuration and manifests bind every selected transport behavior. Existing defaults and historical candidate contracts retain their identities. The broader Truth-stage composition remains subject to full-world validation.

## Pros and Cons of the Options

Immediate default promotion is simpler operationally but outruns the available evidence. A gateway-only override needs fewer registry changes but hides meaningful producer behavior from persisted Composition identity. Explicit composition provides a traceable test boundary and preserves the existing engine path, at the cost of maintaining a named experimental configuration until its outcome is known.

## Links

- [Algorithm registry](../../src/engine/algorithms/registry.ts)
- [Shared request policy](../../src/engine/mechanics/truth-request-policy.ts)
- [Non-thinking experiment](../specs/0029-nonthinking-gameplay-efficiency-experiment.md)
