# Adapter instructions blocked physical repair

Artifact-Version: 1

## Executive summary

A real planning experiment rejected valid physical repair requests locally because a representation adapter appended instructions after the repair notice. The formatter treated its position as an ownership requirement, exhausted structural recovery and triggered batch splitting without sending those repair attempts.

## Summary

The initial model output contained inconsistent dependent effect fields. Its complete rejected output, slot scope and diagnostic were available for repair. The shared catalog adapter retained that evidence and the unique repair instruction, but appended its decoding instructions. Local formatting then failed with `physical repair instruction mismatch`. The experiment subsequently used more HTTP requests and still failed one component; fixing formatting alone does not prove that the model's semantic error would recover.

## Timeline

- A fresh two-group planning diagnostic produced a dependent-effect mismatch in one group.
- The coordinator attached full structural feedback and its physical repair notice.
- The catalog representation appended its own task paragraph.
- Two formatter failures occurred before HTTP, after which the coordinator bisected the original physical group.
- A regression through the coordinator, catalog adapter and actual gateway reproduced the failure using substituted HTTP responses.

## Root cause

The tail renderer required the repair notice to be the task's final text. That assumption was not part of the semantic ownership contract and did not compose with downstream representation adapters. Existing catalog tests covered initial requests and logical repair context, but never drove a malformed physical response through tail rendering. Independent tests of the formatter and codec therefore missed the combined path.

## Guardrails

[Physical repair rendering tests](../../src/engine/prompts/repair-layout.test.ts) require a unique complete notice paragraph, preserve surrounding instructions exactly and reject missing, duplicate or partial notices. [Catalog transport recovery](../../src/engine/mechanics/__tests__/planning-catalog-encoding.test.ts) forces a malformed initial response through real batching, representation and gateway serialization, then verifies two HTTP requests, the unchanged initial prefix, complete rejected output, exact slot scope and source context. These enforce the existing [lossless physical repair contract](../decisions/0119-lossless-physical-repair-tail.md) without changing model validation or recovery ceilings.
