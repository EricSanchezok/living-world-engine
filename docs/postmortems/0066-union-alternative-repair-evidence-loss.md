# Union Alternative Repair Evidence Loss

Artifact-Version: 1

## Executive summary

A bounded source-selection probe removed observed target and means membership errors from its initial complete plan response, but two logical slots still exhausted repair. Check plans first omitted their required effects. Repairs then paired ordinary fact sources with authored factor authority. The schema retained the specific alternative failures, while the model received only `Invalid input` at each factor.

## Summary

First-call mechanical admission improved in the paired development probe, but complete-root admission did not. The remaining repair failure demonstrates an observability gap; it does not prove that richer feedback alone makes the model succeed. Source selection, effect intent, authority choice, semantic review and atomic world commit remain distinct responsibilities.

## Timeline

- The initial candidate response supplied all assigned plans and valid target/means selections.
- Two check plans lacked primary and threatened effects and were rejected before settlement.
- The first repair introduced two authored-factor/fact-source combinations that the schema rejects.
- The next repair received generic union feedback and emitted more of the same invalid combinations.
- Offline reproduction recovered the full nested alternative failures from the existing schema without changing its accepted values.

## Root cause

The [common-discriminator guardrail](0063-nested-union-repair-evidence-loss.md) intentionally exposes only failures shared by every alternative. A fact source with authored authority has multiple possible repairs: retain the fact with semantic authority, or select an actually applicable authored source. Neither field is independently invalid in every alternative. Suppressing the alternative structure avoids a false mandatory correction but leaves the model without actionable evidence.

## Guardrails

The [schema issue projector](../../src/engine/contracts/schema-validation-issues.ts) preserves the original issue and common discriminator constraints. When no common discriminator exists, it additionally exposes the complete reported failure tree, retaining anyOf/allOf grouping and exact paths. It explicitly distinguishes reported failures from sufficient acceptance conditions and never chooses a branch or rewrites a candidate. [Schema regressions](../../src/engine/contracts/__tests__/schema-validation-issues.test.ts) verify a real fact/authority mismatch, both valid repair choices, unchanged raw values, common constraints and genuinely different branch requirements. The [gateway regression](../../src/engine/models/__tests__/model-provider.test.ts) proves that the evidence reaches the actual next repair and that both physical invocations remain counted. Existing whole-schema validation and source checks remain authoritative; measured recovery needs a separate frozen probe.
