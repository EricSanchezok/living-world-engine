# Redundant Decision Tags and Missing Numeral Candidates

Artifact-Version: 1

## Executive summary

Frozen confirmation `narrative-confirmation-1791924259165` exposed two representation failures: the language model sometimes emitted malformed repeated type labels, and a classifier-dependent numeral extractor omitted the requested quantity. The adapter uses scalar answers and reconstructs their types from the questions. The extractor reads whole Chinese numerals without a classifier allowlist.

## Summary

Five player decisions in the 37-turn cohort ended locally with invalid JSON. The instance remained recoverable and subsequent inputs continued, but those attempts produced no narrative. A separate payment selected 120 units instead of the requested two; the resource kernel blocked the impossible debit. The failed payment and its misleading shortage text are retained as failures, not successful resource protection alone.

## Timeline

The rejected decision `edf701a9-13b3-43a5-a615-7a5796bc49db::rt:model-audit:7d0e6f93df11836381d949bdde99f61494350ad074760ab692ed8f7bbfe0cd23` spans Ledger sequences 2278–2290. Its provider response ended normally with 203 output tokens and contained `"expression":{"type":"noul":0.0}`. JSON mode did not prevent this invalid object. In `agreed-exchange-3`, the saved frame has quantity `energy-cell`, amount 120 and a failed outcome, although the player's request specified two cells.

## Root cause

Each fallback answer repeated information already bound by its question: a type discriminator and a same-named value field. A short malformed type/value object invalidated the entire batch. The numeral extractor recognized single Chinese digits only before a small list of counters; the cell classifier was absent. It also could not represent multi-character numerals accurately. A deadline remained among the unrelated available candidates.

## Guardrails

The [decision adapter tests](../../src/engine/models/__tests__/decision-v2.test.ts) exercise scalar Choice, Noul and Score answers through the real gateway, restore the internal typed contract and reject out-of-domain values. The native provider format remains unchanged. The [runtime tests](../../src/engine/direct/__tests__/runtime.test.ts) exercise complete Chinese numeral candidates and an actual two-unit transfer with an unlisted classifier, then replay the state without another debit. The [runtime reference](../game-design/direct-runtime.md) owns the wire and quantity contract. The retired cohort remains in the [qualification driver](../../scripts/experiments/immersive-narrative.ts); replacement confirmation uses distinct frozen inputs.
