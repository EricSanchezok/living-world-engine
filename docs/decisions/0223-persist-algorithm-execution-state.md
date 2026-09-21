# Persist algorithm execution state with the world

## Status

Accepted
Class: architecture

## Context and Problem Statement

An incremental intention interpreter needs durable pending work and issued-action identities. World truth alone does not retain unchosen branches or private condition decisions. A separate mutable file can disagree with a successful or rejected world transaction, while process memory loses progress at restart.

## Decision Drivers

- Preserve atomic world execution, failure rollback and deterministic replay.
- Keep control data separate from truth and subjective knowledge.
- Bind implementation-specific state to its producing Composition.
- Retain complete plans and support ordinary external actions.

## Considered Options

1. Store producer-bound execution state in SimulationState and committed history.
2. Store a mutable sidecar file beside each world instance.
3. Encode execution progress in an Agent's prose action or belief claims.
4. Reconstruct all control choices from world effects alone.

## Decision Outcome

Use a private execution-state document in the canonical persistence envelope under [Spec 0177](../specs/0177-persistent-intent-execution.md). Preparation freezes the proposed document; the committer binds it to the producer and history. Domain-specific validation remains the registered algorithm's responsibility. The document cannot supply world operations or be exposed as an Agent's knowledge.

The intention interpreter consumes completed world evidence at the next preparation boundary. Its journal refers to an already committed step, avoiding a self-referential hash. Issued work and world effects are atomically saved, so recovery can consume the result without repeating the action.

## Pros and Cons of the Options

1. Atomic state makes restart and replay explicit, at the cost of state-schema and history support and potentially larger snapshots.
2. A sidecar limits schema work but requires a second transaction protocol and can duplicate or lose work after a crash.
3. Prose and belief storage reuse existing fields but mix control provenance with intentions or subjective facts and obscure ownership.
4. World effects can establish outcomes but cannot recover private branch decisions or unexecuted alternatives.

## Links

- [Residual intention semantics](0222-execute-residual-intention-programs.md).
- [Architecture](../architecture.md).
