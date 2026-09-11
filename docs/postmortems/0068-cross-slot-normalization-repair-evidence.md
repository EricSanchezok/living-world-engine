# Cross-Slot Normalization Repair Evidence

Artifact-Version: 1

## Executive summary

A physical planning response contained undeclared condition proposals in one logical slot and malformed entity references in another. Both slots correctly failed, but the first slot's next repair received the second slot's schema errors instead of its own normalization failures.

## Summary

The physical provider audit describes the entire response. It cannot serve as the diagnostic source for a single logical candidate after slot recovery. The original physical evidence remains valid; its scope differs from the logical repair scope.

## Timeline

- A source-bound check-feedback probe admitted 29 of 41 actions from its historical first response.
- The first new repair returned undeclared conditions in one slot and invalid target selectors in another.
- Logical normalization rejected the undeclared conditions but retained physical audit issues.
- Semantic repair merged those issues and removed its generic wrapper, leaving only another slot's target errors.
- A regression reproduced both independent failures in one physical call and inspected their next logical repair contexts.

## Root cause

[Slot delivery](../../src/engine/mechanics/truth-batch-provider.ts) replaced physical issues for schema rejection, but omitted that replacement after normalization. The semantic repair loop correctly trusted its supplied logical audit; the audit was not actually scoped to the logical candidate.

## Guardrails

Every schema-valid recovered slot replaces inherited invocation issues with its own complete normalization diagnostics, including an empty list on success. The [coordinator regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) verifies distinct schema and normalization failures reach only their owning logical repair, with local paths and original proposal evidence. Full slot coverage, proposal isolation and rejection rules remain unchanged. This corrects feedback attribution; it does not establish model recovery or gameplay success.
