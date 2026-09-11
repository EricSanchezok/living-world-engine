# Physical repair tails escaped cost attribution

Artifact-Version: 1

## Executive summary

The trajectory cost audit counted physical repair only when feedback appeared inside the context envelope. Moving unchanged feedback to a transport suffix preserved cacheable request prefixes but made those requests invisible to repair attribution. Total HTTP, usage and budget charges remained correct; the reported repair subset was incomplete.

## Summary

A fresh non-thinking gameplay diagnostic sent repeated failed plan batches with the tail layout. Its raw responses and Ledger showed structural recovery, while the initial audit reported only repairs still visible in logical contexts. This could misdirect optimization toward normal stage cost and understate the cost of recovery. The audit already excluded unlabelled repeats and rescheduling, but did not state that a supported explicit feedback layout was missing.

## Timeline

During the 2026-09-08 investigation, one development root passed mechanical and existing semantic review. A fresh full-world trajectory then failed before its first commit. Comparing its repeated malformed JSON responses with the cost table exposed the discrepancy. Inspection confirmed that the gateway had moved the physical feedback after the schema, while the audit still tested only `context.batchRepair`.

## Root cause

The audit treated an internal context location as the complete transport contract. The cache optimization changed that location without changing the semantic purpose of the request. Existing cost tests verified checksums, token totals, tariff arithmetic and interval unions; layout tests verified prefix preservation and feedback retention. Neither exercised repair attribution against the rendered requests produced by both gateway layouts. Budget reconciliation therefore passed while the analysis subset was wrong.

## Guardrails

The [cost attribution helper](../../src/engine/benchmarks/step-efficiency/cost-attribution.ts) recognizes both in-context feedback and a complete post-schema physical repair suffix. It parses the suffix, rejects corrupt or contradictory evidence and records the observed placement. The [regression tests](../../src/engine/benchmarks/step-efficiency/cost-attribution.test.ts) use the actual prompt and layout builders, and distinguish a real suffix from the notice quoted inside action data.

The [audit runner](../../scripts/experiments/step-cost-attribution.ts) applies that helper without modifying the append-only cost ledger or historical raw evidence. Recomputed analysis receives a new content hash. Repair totals remain a lower bound when split descendants or other retries carry no explicit feedback; those categories require lineage evidence and must not silently be counted as normal first-pass work or added again to overlapping failure-tail costs.
