# A Deadline Authorized an Exact Action Duration

Artifact-Version: 1

## Executive summary

The temporal evidence extractor recognized the numeric substring in a deadline as an exact duration. The compiler could then cite that evidence to schedule the submitting actor's work for the entire deadline interval.

## Summary

In the stopped STEP-E2 temporal-contract diagnostic, source batch 010 slot 8 requested submission of a written proposal requiring a committee within thirty days. The source context offered `duration:21:24`, the substring `三十日`, as 2,592,000 seconds of explicit-duration evidence. The model used that evidence for the proposal action. This probe did not commit game state; a separate invented temporal selector rejected its batch.

## Timeline

The original source came from full-world invocation `b19dd856-c1b4-41e4-859c-517ec9222a62::rt:model-audit:e8712d8cde71c43a47a2903a14a0822089ced437e585f4a16da5b526bbdbae98`, Ledger sequences 113–185, capture sequence 182, artifact `fb148b7e43c1b223a0bbddbbb86180f3e7d4f5c513a56a8821abbb7c46a4e516`. The response is retained under `.livingworld-benchmarks/experiments/step-efficiency/v2/http/probes-e2-temporal-contracts-01-http-002/`. A deterministic regression carries the exact source action through evidence extraction, profile eligibility, model basis materialization and temporal plan materialization.

## Root cause

Numeric-unit matching ignored adjacent upper-bound markers. Exact substring matching established that a number appeared in the source, but did not establish that it was an exact work interval. The canonical temporal boundary repeated the same extraction, so it reproduced the same faulty authorization rather than independently rejecting it.

## Guardrails

The [temporal evidence extractor](../../src/engine/mechanics/temporal-evidence.ts) excludes its recognized Chinese and English upper-bound forms from exact-duration evidence while preserving the original text. The [kernel regressions](../../src/engine/mechanics/__tests__/temporal.test.ts) reject the recorded deadline-derived schedule and preserve positive exact-duration controls and original offsets in mixed actions. This is a bounded lexical exclusion: remaining numeric spans can still describe historical events, quoted work or another actor, and require source-action semantic assessment. It does not prove arbitrary temporal language understood correctly or certify gameplay.
