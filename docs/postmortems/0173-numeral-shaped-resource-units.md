# Numeral-shaped resource units

Artifact-Version: 1

## Executive summary

A numeral-shaped resource unit prevented an authorized payment. Unit-aware source candidates preserve semantic selection and inventory enforcement.

## Summary

A live merchant-origin payment could not transfer five taels even though the player owned forty. The resource and recipient were resolved correctly, but the amount candidate set contained 52 rather than 5 because the Chinese unit 两 was consumed as a numeric digit. The world safely refused the incomplete transfer; the intended action still failed.

## Timeline

1. The nine-origin import and initialization checks established separate personal and business balances.
2. Instance `ff79c27b-94e7-4cb3-b500-c360fa2605c6` attempted to give five taels from personal funds to a household helper.
3. The committed frame bound `silver` and the helper but contained `amount: null`. Personal funds remained forty and the business account remained 1,200.
4. Direct inspection reproduced `五两 → [52]` and `三十两 → [32]`. The complete numeral `一万两千` correctly produced 12,000.

## Root cause

Whole Chinese numeral runs were offered to semantic interpretation without considering the script's resource units. A resource unit can overlap the numeral alphabet. The interpreter correctly declined to substitute the wrong offered amount, but it could not select an amount absent from its finite choices.

## Guardrails

Resource-unit boundaries add exact source-span candidates before semantic selection. They do not grant transfer authority or choose the amount. Complete numeral candidates remain available, and an interior unit followed by more numeral characters is not split into a payment amount. Action interpretation, observed numbers, goals and resource-law decisions use the same unit-aware discovery without additional model calls.

[Simulation-entry regression tests](../../src/engine/direct/__tests__/runtime.test.ts) require an actual five-unit debit and credit, unchanged transport count, and replay equality. A separate boundary check retains 12,000 for `一万两千` and covers ordinary nonnumeric units. The responsible producer is pinned as `direct-world@7`.

## Evidence

The original Ledger passed integrity checks with three executions, 218 events, 85 artifacts and 13 audited invocations. [The six-origin first-run record](../../worlds/fanren/authoring/validation/nine-origin-first-runs.json) retains this failure. [The real-model retest](../../worlds/fanren/authoring/validation/merchant-payment-retest.json) committed five units: the player held 35, the helper held five and the business retained 1,200. Its first narrative used a fallback after two rejected drafts, so this is payment-state qualification, not complete presentation qualification. Source-unit matching supplies candidates only; ambiguous language still requires semantic adjudication and inventory conservation.
