# Repeated questions exhausted a world-decision response

Artifact-Version: 1

## Executive summary

A real-model Night City opening sent 405 independent world questions, including 335 instances of the same visibility template. The model used 30,595 reasoning tokens inside a 32,768-token output allowance and ended with `finishReason: length`. The incomplete answer required the one permitted format repair, adding another 119.0 seconds after a 139.8-second first request. Shared question templates remove repeated input without dropping questions, evidence or answer domains; the world decision profile separately reserves 65,536 output tokens. Neither change alone establishes faster or more accurate gameplay.

## Summary

The rejected invocation was `820abaff-4f03-4e02-a0f9-a0c8425ded1a::rt:model-audit:a44dc273111b94a15aef660db852fa934d9bc807ab7e6d1eb3e419bf243a890a`, Ledger sequences 375–688. Its provider usage was 108,738 input tokens and 32,768 output tokens, including 30,595 reasoning tokens. The repair was `820abaff-4f03-4e02-a0f9-a0c8425ded1a::rt:model-audit:ec15cde05c05b6fc2bc9e6add15440b7c33d591cfc1314ae7a8492cb0d586377`, sequences 689–1156. It returned an accepted answer after 130,608 input tokens and 27,557 output tokens, including 24,223 reasoning tokens. No truncated answer was admitted as a world result.

The recorded contexts contain only seven distinct question bodies after extracting their individual data. Applying the production codec offline reduces the first context from 343,656 to 185,862 UTF-8 bytes and the repair context from 448,956 to 187,745 bytes. These are exact context-byte measurements, not provider-token measurements or latency estimates. The full state, question data and existing output schema remain present. Live semantic and latency qualification is separate from reversible encoding.

## Timeline

- On 2026-10-17, the real-model opening issued a complete world-decision batch while several other origins ran concurrently.
- The first response reached its output ceiling after 139.8 seconds and failed structured-output validation.
- The bounded repair retained all 405 unanswered questions, adding repeated correction wrappers, and succeeded after another 119.0 seconds.
- Ledger inspection identified repeated question structure and the reasoning/output split. The runner was stopped before continuing acceptance on the unqualified configuration.
- A gateway-entry regression exposed that JSON canonicalization sorts object keys. The compact layout therefore stores question references as an ordered array so the physical request can retain every original question ID and order.

## Root cause

The language-model transport repeated complete instructions and criteria for every question. Most questions differed only in `instructions.data`; repair repeated the same correction and original instructions around each unanswered question. Byte-budget checks did not establish whether the remaining output allowance could hold a complete answer after reasoning. A profile allowing 32,768 output tokens left only 2,173 tokens outside reasoning in this request. Reusing templates reduces redundant input; the larger pinned output allowance addresses a distinct capacity constraint.

Existing deterministic decision tests covered question types, invalid answers and bounded repair with small batches. Their transport fixtures returned complete answers immediately, so they did not expose large repeated payloads or provider output exhaustion. The production schema correctly rejected the truncated answer, but that guard runs after the costly request and cannot prevent its latency. Splitting batches or dropping visible facts would change a different boundary and was not required to remove the measured redundancy.

## Guardrails

- The [decision codec](../../src/engine/models/decision-question-templates.ts) shares only identical question bodies. It retains per-question data, null values, sources, domains and ordered IDs; the [language prompt](../../src/engine/prompts/user/direct-decision.md) defines exact reconstruction and answer keys. Native TypeSafe transport is unchanged.
- [Gateway-entry regressions](../../src/engine/models/__tests__/decision-v2.test.ts), “factors a complete 405-question language request without changing decisions,” exercise initial requests, format repair and native fallback through real request assembly with only HTTP replaced. They verify seven templates, all 405 questions, unchanged shared state and output schema, exact restoration, and unchanged physical-call counts. A companion regression covers primitive, array, null and nested data and source ordering.
- The [browser test model service](../../e2e/support/model-server.ts) restores the same language layout before selecting responses and publication gates. Existing [conversation flows](../../e2e/flows/immersive-game.spec.ts) reject fallback text where a generated response is required; they exposed a missed fixture decoder during integration.
- The [model profile](../../config/models.yaml) pins `decision-deepseek-long` to a 65,536-token output allowance and a 300-second request timeout. The [profile matrix tests](../../src/engine/models/__tests__/model-provider-matrix.test.ts) bind those settings without changing low reasoning effort or batch size.
- [Decision 0090](../decisions/0090-model-reliability-optimization-and-local-transparency.md) requires measured lossless layout and prompt work before reducing batch cardinality or adding calls. Real provider usage, first-pass rejection, repair recovery and terminal failure remain distinct evidence.
