# Reviewed account-currency valuation

## Status

Accepted
Class: process

## Context and Problem Statement

An experiment may reserve requests using a currency-conversion margin above the provider's documented account-currency peak rate. Treating that margin as irrevocably incurred cost can prevent funded validation, while overwriting the policy would invalidate historical evidence. Known usage and unknown billing require different treatment.

## Decision Drivers

Preserve all incurred usage, uncertainty, source evidence and budget limits while allowing a deliberate correction to an estimate that exceeds the reviewed peak tariff.

## Considered Options

- Keep the original conversion margin authoritative indefinitely.
- Rewrite the historical price policy or assume dispatch-time discounts.
- Append an evidence-bound peak-price review for known settlements only.

## Decision Outcome

Use an explicit reviewed valuation for enumerated settled requests. Bind their usage and original price hashes, preserve original and revised totals, and replay both from the same journal. Unknown reservations and future dispatch prices retain their original ceilings. The reviewed account-currency peak rates must be positive, no higher than the original rates and bound to the same account/model. The review requires a drained writer and an external evidence bundle; runners never infer it from a successful response.

## Pros and Cons of the Options

Keeping the conversion margin is simple but can confuse a protective estimate with actual spending. Rewriting prices destroys provenance, and discount-based repricing depends on historical timing rules that can be uncertain. The append-only review preserves evidence and conservative admission at the cost of an explicit accounting operation. It remains an estimate and cannot certify account debits or gameplay efficiency.

## Links

- [Reviewed valuation contract](../specs/0078-reviewed-cny-peak-budget-valuation.md)
- [Budget journal](../../src/engine/benchmarks/action-compilation/experiment-budget.ts)
- [DeepSeek CNY tariff](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
