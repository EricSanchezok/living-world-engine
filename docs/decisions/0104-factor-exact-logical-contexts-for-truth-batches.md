# Factor Exact Logical Contexts for Truth Batches

## Status

Accepted
Class: architecture

## Context and Problem Statement

Trusted Truth and Observation requests can share a world snapshot while assigning different actions or observers. Repeating complete state and catalogs per slot makes batching expensive and can overflow a provider limit. Removing fields instead risks changing the model's available evidence. A transport representation must preserve every logical task and its reference authority.

## Decision Drivers

- Preserve each complete logical context, including slot-specific repairs and catalogs.
- Keep existing output schemas, materialization and canonical validation.
- Measure reduced transmission independently from model correctness.
- Bind experimental representation changes to an explicit Composition child.

## Considered Options

- Repeat complete contexts in every slot.
- Share only identical top-level sections.
- Recursively factor exactly equal JSON subtrees and retain per-slot differences.

## Decision Outcome

Use recursively factored JSON in the candidate `shared-context-slot-batching` implementation. Common object fields are inherited; slot differences override objects recursively and replace arrays or scalars completely. Reference candidate arrays first become dictionaries keyed by existing handle, with each slot retaining its complete original ordering separately. This makes identical catalog entries shareable even when a verifier adds component-specific plan references. Reconstruction restores the candidate array before checking the complete original context hash. Other arrays remain indivisible and retain their original ordering. The model receives a compact reconstruction rule, while each logical caller validates its own typed output and references.

The batching child binds codec and prompt versions in its manifest. The production-default batching child retains its separate baseline representation for controlled comparison. Live acceptance, rather than byte compression alone, determines promotion. Distinct cancellation lifetimes, execution envelopes, model settings or authority contracts cannot share a physical request.

## Pros and Cons of the Options

Complete repetition requires little interpretation but scales input with the number of slots. Top-level sharing is simpler but cannot share a stable world when the same state section contains assigned actions or component-local receipts. Recursive exact factoring captures that shared structure and has a mechanical round-trip proof, at the cost of requiring the model to interpret inheritance. This proof establishes information preservation, not equivalent model behavior; paid output and trajectory checks remain necessary.

## Links

- [Full-step experiment contract](../specs/0026-full-step-efficiency-experiment.md)
- [Codec and state-binding tests](../../src/engine/mechanics/__tests__/shared-batch-context.test.ts)
- [Production schema and cancellation-boundary tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts)
- [Composition and independent budget](../../src/engine/benchmarks/step-efficiency/protocol.ts)
