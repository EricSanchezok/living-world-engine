# Direct Slot Task Excerpts

## Status

Accepted
Class: architecture

## Context and Problem Statement

Shared-context batches are mechanically reversible, but a model must reconstruct its task from a large shared object and per-slot differences. Empty outer task stubs can leave the nearest visible task envelope without the action responsibility that the original logical calls contain. Mechanical losslessness alone does not establish model usability.

## Decision Drivers

- Keep the complete world context, action batches, catalogs and slot boundaries.
- Make each slot's actual responsibility directly readable near the output schema.
- Establish every excerpt through the original state/context hash.
- Measure any added tokens against recovered work rather than claim free compression.

## Considered Options

1. Require the model to reconstruct all task details without excerpts.
2. Remove shared world evidence or reduce action counts.
3. Add direct copies of the original slot task and assigned action/dependency records.

## Decision Outcome

Use hash-verified direct excerpts as an experimental layout treatment. Expand each shared context, verify its original hash, and copy only that slot's original task fields, assigned actions and assigned dependencies into the outer task slot. Preserve the entire encoded context and all remaining envelope fields. The layout changes neither output schemas nor canonical validation. Its first consumer is an offline full-context probe; production batching remains unchanged until the candidate meets its prospectively recorded gate.

## Pros and Cons of the Options

Reconstruction alone minimizes repetition but puts indexing work on the model. Dropping context or actions conflicts with the experiment's semantic and batch constraints. Direct excerpts cost additional input tokens, but expose exact existing responsibility without inventing action meaning or widening references. Their value requires observed formal recovery and later full-step validation.

## Links

- [Shared context codec](0104-factor-exact-logical-contexts-for-truth-batches.md)
- [Full-step experiment](../specs/0026-full-step-efficiency-experiment.md)
- [Layout binding tests](../../src/engine/mechanics/__tests__/direct-slot-task-layout.test.ts)
- [Lost in the Middle](https://arxiv.org/abs/2307.03172)
