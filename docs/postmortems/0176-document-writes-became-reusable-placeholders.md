# Document writes became reusable placeholders

Artifact-Version: 1

## Executive summary

A real-model mechanic performed repair work and then attempted to write the results into a work log. The existing text property required an open value, but the capability creator returned a reusable effect whose literal value said that the record had been written. World adjudication admitted that effect and the kernel stored the placeholder exactly. The failure was a mismatch between reusable methods and concrete action results, compounded by missing author evidence at creation. Existing text replacements now use action-bound candidates and complete world review.

## Summary

The affected action was `rt:action:8755db9fce37d2eba8bed982d328baa21bbbd3b8f362a2534cf3f509920ac06f` in execution `a9eba92d-d50e-4200-92f9-a05c15e02930`. The initial decision selected `new_value` for the log's `entries` property in invocation `a9eba92d-d50e-4200-92f9-a05c15e02930::rt:model-audit:957daa87511397e89a502c7b635b665dedd3cb93906781982d2e30cee3b1fda8`, Ledger sequences 4602–4856. The requested action specifically named the valve work, leak test, unloaded cooling results and unfinished loaded test.

The first anomalous boundary was capability creation, invocation `a9eba92d-d50e-4200-92f9-a05c15e02930::rt:model-audit:617fd5fc4995772f23b6d0d74bab2d866fdde02ec62d92fb1eabefd9ea1345b2`, sequences 4858–5082. Its literal effect value was “已写入按实际工序和观察形成的记录正文；未完成项目明确标注为待做，未作适运签认。” The admission invocation `a9eba92d-d50e-4200-92f9-a05c15e02930::rt:model-audit:cb46e202979d822c5118ba62c697e225fa41e5342a21a342eba4648704af13a0`, sequences 5083–5182, applied it. The committed value contained no actual work-log entries. Another document's replacement described an append without preserving its existing text.

## Timeline

- On 2026-10-17, real-model origin acceptance reached the mechanic's work-log action and exposed a placeholder in committed truth.
- Ledger inspection followed the authored action, initial property decision, creation response, effect admission and commit. The kernel reproduced the literal effect; it did not discard a supplied document body.
- An isolated real-model comparison strengthened only the world's record description. Both outputs passed the capability schema, but the candidate still emitted editing instructions instead of the actual record. That world-only change was not applied.
- The replacement boundary separated action-bound values from reusable declarations. Gateway and simulation regressions exercised multiple edits, cached capabilities, explicit corrections and clearing, and actual observations.
- Independent review exposed three further regressions: old literal effects could override an explicit choice equal to the current text; copied descriptions could still assert old content; and unioning visibility by fact ID could reveal the wrong value. Failing regressions reproduced these cases before the fixes. Final settlement also required separate original/candidate visibility for resource conflicts after preparation.

## Root cause

The open-value path asked a creator designed to produce concise reusable methods for a particular resulting text. It supplied the action and public role properties but omitted the author's actual retained work evidence. The requested document property was private and therefore absent from the public property context. A valid reusable declaration could contain a grammatical placeholder, and the admission question evaluated method applicability rather than the exact document body. Reuse could later write the same literal again.

Existing tests demonstrated a single qualitative scalar change. They did not require actual document content, append preservation, a second distinct edit, or player evidence matching the updated value. Schema validity and a successful action status therefore appeared sufficient. They were insufficient for semantic content. Visibility was represented only by fact identity, which also failed to distinguish a visible old value from a hidden replacement or a visible proposal that never committed.

## Guardrails

- [Action-bound property creation](../../src/engine/direct/property-values.ts) uses the exact existing properties and the author's private evidence. Its values remain outside the reusable capability catalog; a mixed concept/value request shares one creation call. [Decision 0251](../decisions/0251-action-bound-values-outside-reusable-capabilities.md) records the alternatives and cost tradeoff.
- [World adjudication](../../src/engine/direct/world.ts) reviews the exact candidate, evidence, edit intent and access in the existing supplemental batch. A separate original-value visibility question applies when the replacement does not commit. Explicit selected text takes precedence over cached literal effects even when it equals the current value.
- [Settlement](../../src/engine/direct/settlement.ts) selects visibility using the actual surviving operation and value hash. [Control-state version 4](../../src/engine/direct/contracts.ts) requires the original/candidate visibility bindings and rejects obsolete preparations through its producer and state identities. [Changed-fact descriptions](../../src/engine/direct/presentation.ts) keep observed content consistent with the value.
- [HTTP and simulation-entry regressions](../../src/engine/direct/__tests__/property-values.test.ts) require concrete contents, retained appends, distinct later edits, corrections and complete clearing; reject placeholders; check hidden knowledge, observations, claims and evidence; preserve Boolean changes; and keep ordinary call counts unchanged. They also exercise both visibility directions after a later settlement debit conflict using an actual saved preparation.
- [Existing-property runtime regressions](../../src/engine/direct/__tests__/runtime.test.ts) require open qualitative updates to replace the stale description and appear in actual observations. [Spec 0195](../specs/0195-action-bound-text-values.md) owns the complete contract. Deterministic model transport proves the engine boundary, not real-model gameplay quality or latency.
