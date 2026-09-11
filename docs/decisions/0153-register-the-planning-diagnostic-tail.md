# Register the planning diagnostic tail

## Status

Accepted
Class: feature

## Context and Problem Statement

Complete diagnostic requests appended a planning-contract and intent reminder after the schema. That layout returned all assigned plans but was not part of the registered game configuration. Testing or promoting the configuration without it would test a different input.

## Decision Drivers

Reproduce the measured behavior, retain complete inputs and scope, account for every instruction and preserve targeted repair ownership.

## Considered Options

- Continue editing raw HTTP bodies only in experiments.
- Promote an algorithm that omits the measured tail.
- Register the optional layout and verify actual transport equivalence.

## Decision Outcome

Register the layout under [spec 0090](../specs/0090-registered-planning-contract-tail.md). Expose a JSON-object-only postlude through the internal model request, accounting and adapter. Generate it from the current complete indexed worklist and maintained instruction assets.

## Pros and Cons of the Options

Raw-body experiments remain useful evidence but do not define game behavior. Omitting the tail makes a different experiment. Explicit integration adds a small rendering option and input repetition, but makes runtime configuration, billing evidence and the tested prompt consistent. It does not establish semantic success or game fluency.

## Links

- [Registered planning contract tail](../specs/0090-registered-planning-contract-tail.md)
- [Visible fact evidence](0152-place-visible-facts-beside-means-options.md)
