# Reviewed CNY Peak Budget Valuation

Artifact-Version: 1
Status: Approved

## Intent

Use evidence-backed account-currency peak tariffs for known experiment usage while preserving the original conservative valuation. The user authorizes autonomous work within CNY1000 and explicitly asks to correct monetary accounting after confirming the account display is CNY. An artificial USD conversion margin is not an incurred charge.

## Contract

A deliberate, drained-writer review may append a peak-price valuation for explicitly enumerated settled requests. Bind the original price hash, every request's unchanged usage hash, the same account and model, the reviewed positive rates and source, and a reason plus evidence hash. Reject unknown usage, duplicate or repeated valuations, mismatched bindings and increases above the original conservative rates. No transport performs this review automatically.

Preserve every original journal byte, price policy, request, token count, failure status and trial identity. Report original and reviewed conservative known totals separately. Only the reviewed known totals enter subsequent phase and total admission; all unresolved requests keep their original full reservations. Fresh requests retain the original conservative rates. The total authorization remains CNY1000. A valuation is a tariff-based upper estimate, not an invoice, discount, refund or model-efficiency gain.

For STEP-E2, review all known usage against the documented CNY peak tariff, never the dispatch-time discount. Bind the prior CNY pricing record, current official verification, complete request/response usage audit and the immutable journal prefix. Preserve the unknown request's full hold. Any phase reallocation must retain incurred exposure and fund both the complete fresh trajectory and independent confirmation at their existing CNY150 caps; keep all samples and semantic gates.

## Plan

Add an explicit append-only price-review entry and deterministic replay validation. Extend the existing cost audit to reconcile original valuation and reviewed admission separately. Freeze a local evidence bundle, exercise review and full-run admission on a copied journal, and run relevant tests plus check:fast before committing. Only after successful review may the original journal receive the same evidence-bound entry and prospective allocation.

## Verification

Prove that correcting known prices changes subsequent budget decisions while keeping original charges visible, unknown holds unchanged, future request prices intact and closed trials closed. Reject altered usage, account/model/price hashes, duplicate IDs, active writers, unquarantined uncertainty, zero/negative or higher rates, and repeated reviews without writing. Replay must reproduce the reviewed totals and reject a tampered entry even when its checksum is recomputed. Reconcile every settled request against its actual recorded response before applying the real review.

## Evidence

[Budget tests](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts) own accounting and replay. [Cost attribution](../../scripts/experiments/step-cost-attribution.ts) owns the complete HTTP/usage audit. [Decision 0142](../decisions/0142-reviewed-account-currency-valuation.md) records the choice. The [official tariff](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) is the pricing authority; local evidence retains dated observations rather than claiming a historical invoice.
