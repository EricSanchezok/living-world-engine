# Provider model cohort accounting

Artifact-Version: 1
Status: Approved

## Intent

Continue the authorized non-thinking gameplay experiment when the provider retires its pinned model. Record the replacement explicitly and compare baseline and candidate within one served model cohort. Provider upgrades cannot be credited to algorithm changes.

## Contract

The existing experiment journal and user spending tranche remain authoritative. New evidence-bound price registrations append immutable account/model/rate snapshots without changing the policy hash, authorization, previous requests, unknown holds or phase limits. Price identifiers cannot be replaced. Transport accepts only the registered account and exact requested model, and retains strict response model validation.

A completed response from a documented provider routing change may be reconciled only with explicit original and served model identities, complete usage, a registered price for the same account, and a hash binding the original request, response and official routing/pricing evidence. Reconciliation cannot exceed the original token or monetary reservation, fabricate a successful sample, or reopen the stopped source trial. Other unknown sends retain their full original reservations. Actual invoices remain separate from conservative peak-tariff estimates.

The optional replacement cohort selects deepseek-flash, documented as DeepSeek-V4.1-Flash, with thinking disabled and unchanged generation settings. Each new manifest binds cohort and price hashes. Frozen historical protocols, world snapshots, saves and outputs remain unchanged. New comparisons use identical source state and actions in both arms on the replacement model; historical cross-version runs remain descriptive only. Model replacement by the provider does not establish that an algorithm transfers to smaller models.

## Plan

Extend the existing budget journal with immutable model-price registration and explicitly reviewed routed-response reconciliation. Reuse its reservations, admission, lock and recovery paths. Select registered prices in the existing HTTP transport. Expose the replacement cohort through the non-thinking experiment runner and full-world profile assertions, preserving the original cohort when no replacement is selected.

## Verification

Test append-only replay, preservation of the current tranche and unknown costs, duplicate and invalid registration, mismatched model/account/hash/usage, over-ceiling reconciliation, permanently closed routed trials, and exact transport model/thinking enforcement. Verify new cohort profile and manifest bindings without changing source worlds or historical saves. Run focused tests and check:fast before committing. Freeze source-matched live trials before dispatch.

## Evidence

The authoritative [provider pricing and retirement notice](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) and [release history](https://api-docs.deepseek.com/zh-cn/updates) define the external change. The [experiment budget](../../src/engine/benchmarks/action-compilation/experiment-budget.ts), its tests and the [non-thinking protocol](../../src/engine/benchmarks/step-efficiency/nonthinking-protocol.ts) own the implementation evidence. Raw provider requests, responses and documentation snapshots belong in the local experiment directory.
