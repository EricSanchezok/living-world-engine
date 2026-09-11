# Order Random Consumption Without Resampling Plans

## Status

Accepted
Class: architecture

## Context and Problem Statement

Independent truth components share one canonical random stream. Speculative resolution followed by serial resolution preserves stream order but repeats model decisions whenever any component consumes randomness. Assigning separate seeds would change the world's random commitments.

## Decision Drivers

- Preserve canonical component order, conditional draws and replay.
- Avoid regenerating successful plans solely to recover random order.
- Retain parallel planning before the first random commitment.
- Release all waiting components after an atomic failure.

## Considered Options

- Speculate complete resolutions and repeat them serially when randomness occurs.
- Serialize every component from its first model request.
- Gate the first random draw in canonical component order.

## Decision Outcome

The candidate `ordered-rng-truth-resolution` gates each component's first random consumption until its predecessor closes all random commitment rounds. A component retains the stream across its conditional rounds and publishes its final state once before transition generation, observation rendering and causal review. Those later stages and their repairs cannot draw again. Components without draws inherit the predecessor's final state. Initial planning and validation remain parallel. The gate is restricted to component resolution with reaction routing closed, so onset perception cannot consume an unowned stream. Failure rejects waiting gates and cancels pending model work through the existing atomic cancellation domain.

The candidate remains explicitly pinned by Composition. Actual dependency conflicts retain global readjudication; this mechanism eliminates only replay caused by random stream ordering.

## Pros and Cons of the Options

Full speculation preserves parallel latency for nonrandom work but duplicates expensive model work on random paths. Complete serialization avoids duplication but delays independent planning. Ordered acquisition retains independent planning and one canonical stream, while later random components wait for earlier components' outcome-dependent continuation. It requires explicit acquisition and completion ownership, tested against the serial reference rather than relying on distributional similarity.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Commitment-stage release contract](../specs/0073-release-random-stream-after-commitments.md)
- [Ordered stream tests](../../src/engine/mechanics/__tests__/ordered-random-stream.test.ts)
- [Real engine and replay comparisons](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts)
- [Atomic cancellation](0103-drain-active-model-work-after-atomic-failure.md)
