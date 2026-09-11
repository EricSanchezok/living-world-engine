# Preserve Shortlist Reference Evidence

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

Candidate retrieval limits the executable reference catalog, but selected records can refer to records outside that shortlist. Replacing those references with null asserts an absent relationship rather than a retrieval boundary. Removing null array entries also changes source structure. The compiler needs truthful state evidence without acquiring additional output authority.

## Decision Drivers

- Preserve source facts, reference equality, literal nulls and ordered arrays.
- Retain the root batch candidate budget and slot-specific output permissions.
- Bind model-visible evidence to the exact full context and keep replay provenance explicit.

## Considered Options

1. Replace nonselected references with null or omit their fields.
2. Recursively add every referenced record to the executable shortlist.
3. Encode nonselected references as source-bound read-only identities.

## Decision Outcome

Choose read-only snapshot identities. Selected candidate records retain their structure, with nonselected references represented by snapshot objects and a dictionary carrying their source label, kind, meaning and scope. An exact inverse check binds those records to the full source context. The executable catalog and per-slot membership remain authoritative for outputs; snapshot objects and keys fail the existing output reference schema. The retrieval runtime version pins this projection.

The projection guarantees structural source fidelity, not correct model interpretation or gameplay success. Those outcomes remain separate measurements under the experiment contract.

## Pros and Cons of the Options

Null or omission is compact but loses relationship evidence and can change the apparent world. Recursive executable expansion retains details but defeats the bounded shortlist and broadens output choices. Read-only identities preserve source relationships and permissions with a smaller dictionary, at the cost of additional input tokens and another representation the model must interpret.

## Links

- [Source-bound projection](../../src/engine/algorithms/eager-reference/candidate-retrieval/shortlist-evidence.ts)
- [Production retrieval regression](../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime.test.ts)
- [Exact inverse and reference rejection tests](../../src/engine/benchmarks/step-efficiency/shortlist-evidence.test.ts)
- [Incident](../postmortems/0057-shortlist-pruning-falsified-state-references.md)
- [Non-thinking gameplay experiment](../specs/0029-nonthinking-gameplay-efficiency-experiment.md)
