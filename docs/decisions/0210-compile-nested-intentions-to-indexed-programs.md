# Compile Nested Intentions to Indexed Programs

## Status
Accepted
Class: testing

## Context and Problem Statement

An indexed intention tree asks the model to choose work and maintain node IDs, child references and two levels of target references. Those bookkeeping choices can invalidate an otherwise representable intention. Recursive containment makes parent-child ownership part of the generated value and permits deterministic indexing afterward.

## Decision Drivers

- Retain complete open plans, concurrency, conditions and repetition.
- Remove redundant model-authored graph and target indices.
- Preserve existing canonical validation and rejected-output evidence.
- Separate syntactic well-formedness from semantic qualification.

## Considered Options

- Add more instructions to indexed-program generation.
- Relax graph reachability and target-coverage validation.
- Generate recursive intentions and compile their indices deterministically.
- Restrict every choice to one immediate primitive action.

## Decision Outcome

Use the isolated [recursive intention screen](../specs/0164-recursive-intent-tree-screen.md). Compare it with the indexed producer. The compiler retains the entire chosen tree and uses the existing indexed diagnostic embedding and validators; it does not implement world execution or infer a correct plan.

## Pros and Cons of the Options

Additional instructions preserve the wire but leave redundant index generation with the model. Relaxing validation admits ambiguous or discarded work. Recursive containment removes those representable structural errors and binds targets directly to their leaves, at the cost of repeated handles and a recursive generation schema.

A single primitive choice reduces output but cannot represent an unrestricted compound undertaking. The recursive producer retains that scope. Its free-text leaves and conditions still require semantic adjudication, and a compound leaf may still hide its own temporal boundary.

## Links

- [Indexed source programs](0207-generate-structured-intentions-at-decision-time.md).
- [A Syntactic Neural Model for General-Purpose Code Generation](https://aclanthology.org/P17-1041/), sections 2–3, generates AST structure and converts it to surface code deterministically. The paper's trained grammar decoder motivates this representation boundary; this experiment does not reproduce that model, constrained token decoding, execution correctness or its reported performance.
