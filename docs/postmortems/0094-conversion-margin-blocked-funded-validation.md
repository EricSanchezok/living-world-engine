# Conversion margin blocked funded validation

Artifact-Version: 1

## Executive summary

A deliberately conservative USD conversion margin became the only authoritative valuation for an experiment billed in CNY. It preserved the spending ceiling but overstated known tariff-based exposure and blocked the full validation allocation. An append-only peak-price review separates original estimates from reviewed admission without removing usage or uncertain reservations.

## Summary

The operator questioned the gap between reported experimental cost and the CNY provider dashboard. Existing reports could estimate documented CNY tariffs, but admission continued using USD peak prices multiplied by eight. The original known estimate was CNY809.93; valuing the same known tokens at the reviewed CNY peak tariff yields CNY690.74. Neither figure is an account invoice. The unknown request's original hold remains CNY4.90.

## Timeline

- The first-pass experiment recorded the CNY peak tariff before the later gameplay trials.
- Gameplay admission adopted a larger USD conversion ceiling and correctly retained every known token and unknown reservation.
- A later pricing audit separated CNY estimates in reports but deliberately left admission unchanged.
- After the user confirmed the account currency, the complete usage audit and original pricing record established a reviewable account-currency valuation. The full CNY300 trajectory and confirmation allocation could be considered without lowering sample counts.

## Root cause

The journal supported immutable price bindings, usage-overrun review and phase reallocation, but had no explicit way to revise an overly conservative known-cost estimate. Rewriting the policy would invalidate history; leaving the excess estimate authoritative made a reporting caveat into a persistent operational blocker. Tests covered overspending and uncertainty preservation but not evidence-backed estimate correction followed by full-run admission.

## Guardrails

[Budget regressions](../../src/engine/benchmarks/action-compilation/experiment-budget.test.ts) verify append-only valuation, original totals, unchanged unknown holds, future conservative prices and replay-safe admission. [The complete usage audit](../../scripts/experiments/step-cost-attribution.ts) reconciles recorded request/response usage and reports original role costs separately from reviewed admission. [The reviewed valuation contract](../specs/0078-reviewed-cny-peak-budget-valuation.md) prohibits automatic repricing, discounts and invoice claims.
