# Native Batch Reservation Ceiling

Artifact-Version: 1

## Executive summary

A live Jev batch exceeded its fee reservation and paused further paid work. The transport retained the request but discarded the returned usage when settlement threw. The fee bound now covers the full request, and settlement errors preserve usage for review.

## Summary

Trial `narrative-continuous-1791919900995` stopped during its eighth harbor turn. Earlier committed observations and world additions remained saved; fourteen planned turns did not run. The original request remains an unknown cost, with an enlarged conservative hold and a permanently closed trial.

## Timeline

- Invocation `aafbe533-e8cd-49c2-8d5c-b0fa2d86057b::rt:model-audit:0a438d79fecd356e0181f36e6832d7579a1b9def7b79bbfa4fd303f3d4eaf751`, Ledger sequences 1194–1203, retained a 238,477-byte native request with 39 questions.
- The budget transport rejected settlement against the fixed 64,000 input-token ceiling. The exact returned usage was not retained.
- Request `e8f074f3-5f52-46f7-9f04-756db4e01292` remains unpriced usage with a reviewed 242,573-input-token hold; no fabricated usage or additional request count replaces it.

## Root cause

The live wrapper treated a decimal 64,000 allowance as an exact billing ceiling. The [provider model reference](https://docs.typesafe.ai/models) describes a combined 64k request budget and a separate state-plus-longest-question constraint; the fee reservation needs a conservative bound. Throwing during settlement before the response reached the gateway also lost the evidence needed to account for the overrun precisely.

## Guardrails

The [live transport tests](../../src/engine/benchmarks/jev/live-budget.test.ts) cover the native boundary, complete-request fee reservation and preserved usage after a settlement error. The [budget recovery tests](../../src/engine/benchmarks/jev/live-runtime.test.ts) verify append-only increased unknown holds, one actual request count, replay and permanent trial closure. The [experiment driver](../../scripts/experiments/immersive-narrative.ts) does not launch full-roster qualification while unknown usage blocks dispatch. [Narrative measurement](../game-design/narrative.md#evidence-and-measurement) owns the live accounting contract. Byte bounds reserve fees; they do not reject semantic context or trigger model fallback.
