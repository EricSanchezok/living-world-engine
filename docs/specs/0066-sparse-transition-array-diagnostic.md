# Sparse Transition Array Diagnostic

Artifact-Version: 1
Status: Approved

## Intent

Within the [delegated non-thinking experiment](0029-nonthinking-gameplay-efficiency-experiment.md), test a declared representation that removes the need to spell empty root effect arrays. A recorded canonical transition failed three times by emitting outcomes without the other four required containers. This is a prospective codec experiment, not retrospective parsing recovery.

## Contract

Only canonical single-request transitions use this research representation. The wire schema permits omission of mechanicInvocations, operations, events and decisionRequests; omission explicitly means an empty list. Supplied arrays retain all items and order. Null, wrong types, unknown fields, missing outcomes and missing nested requirements remain invalid. The decoder supplies no outcome, assertion, reference, quantity, event or effect. Canonical schema, materialization, causal checks, source semantics and atomic commit remain authoritative.

Encoding a valid canonical value by omitting only its empty effect arrays and decoding it restores that value exactly. Explicit empty arrays also remain valid wire input. Original context, previous candidate bindings, action count, full state and model settings remain unchanged. The conflicting explicit-empty instruction is replaced with the precise sparse contract. The registered gameplay path does not select the codec until a separately frozen admission and candidate identity exist.

## Plan

Prepare a fixed B/T diagnostic of the original initial Kostbera transition from trajectory-e2-14. B reconstructs its complete historical request; T changes only the declared root representation and matching instruction. Both issue one HTTP with DeepSeek Flash and thinking disabled, with no repairs or response-dependent adjustments. Freeze source, code, schema, actual body, tokenizer and complete-pair budget before dispatch. The historical failed outputs remain failed under their own contract.

Report schema and source-reference admission separately from source-semantic review. In particular, an outcomes-only response cannot establish a persistent write or an unsupported completion. Controlled real-step tests must preserve a required nonempty effect, and an independent source-bound behavior oracle must reject a missing-effect mutant against the actual committed state. Scripted surrounding semantic roles can admit that mutant; the test does not claim that the transaction kernel establishes arbitrary action intent. A treatment pass permits only a future full-world diagnostic; it does not establish overall reliability, cost improvement or gameplay. Stop the pair on integrity, budget or transport uncertainty and preserve partial evidence.

## Verification

Exercise canonical round trips, unchanged nonempty arrays, null and wrong-type rejection, missing outcomes and nested fields, repeated-codec rejection and unchanged source/repair bindings. Compare actual gateway bodies and disabled inference. Use the real loader, engine, transaction and replay for supported state changes, with independent behavior acceptance vetoing a missing effect. Run relevant tests and check:fast before local commits.

## Evidence

[The canonical evidence contract](0063-canonical-transition-evidence.md) owns the unchanged source worklist. [The sparse codec](../../src/engine/mechanics/canonical-sparse-arrays.ts) and [its regression tests](../../src/engine/mechanics/__tests__/canonical-sparse-arrays.test.ts) own the experimental representation.
