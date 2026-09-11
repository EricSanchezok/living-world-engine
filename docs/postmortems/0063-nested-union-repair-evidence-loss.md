# Nested Union Repair Evidence Loss

Artifact-Version: 1

## Executive summary

A resolution factor cited a quantity where the existing schema permits other evidence types. The validator retained that specific failure inside nested union alternatives, but the repair projector exposed only `Invalid input` at the factor object. Recovering JSON syntax made the remaining diagnostic loss observable; it did not make the source valid.

## Summary

The source-bound syntax recovery experiment retained valid logical slots but failed its complete-admission gate. Later repairs moved an unsupported quantity reference into another source field. This establishes incomplete feedback and repeated invalid output, not that better diagnostics alone would have made the model succeed. Existing source categories, grounding permissions, semantic checks and recovery limits remain unchanged.

## Timeline

- The original complete response contained a nested factor union failure.
- Restricted syntax recovery allowed six of eight logical slots to reach materialization; the invalid factor remained rejected.
- Repair feedback described the factor only as `Invalid input`, although nested validator evidence named the unsupported source discriminator and allowed alternatives.
- Paid repairs retained seven slots but exhausted recovery on quantity means and unsupported causal source types.
- Offline reproduction through the real adapter, dependent-field codec and gateway confirmed the nested failure and retained the exact rejected value.

## Root cause

The earlier [wrapper-path fix](0044-schema-error-wrapping-erased-repair-paths.md) recovered the outer Zod issues but did not interpret their nested alternative structure. Flattening all branch errors would also be wrong: a failed alternative can require a different role or authority without making those requirements necessary in another valid alternative.

## Guardrails

The [schema issue projector](../../src/engine/contracts/schema-validation-issues.ts) preserves every original issue and additionally reports a discriminator constraint only when all union alternatives fail at that same field. Allowed values are united across alternatives; no branch is chosen. Original values come only from the closest schema-owning output wrapper, with absent evidence left absent. The [schema regressions](../../src/engine/contracts/__tests__/schema-validation-issues.test.ts) cover nested resolution factors, branch-only constraints and wrapper mismatches. The [gateway regression](../../src/engine/models/__tests__/model-provider.test.ts) verifies the rejected field, exact value, preserved raw output and single HTTP boundary. This guardrail improves evidence without accepting or rewriting invalid output. Any measured recovery benefit requires a newly frozen experiment.
