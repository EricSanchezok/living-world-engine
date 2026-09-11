# Plan Schema Advertised Invalid Evidence

Artifact-Version: 1

## Executive summary

A complete 38-plan response used existing action identifiers correctly but cited each plan's own proposal as an action cause. The advertised schema accepted every plan; the materializer rejected all of them. Repeated regeneration followed a contract mismatch rather than malformed JSON.

## Summary

The source-bound shared-prefix trial exposed this independently of its caching treatment. A generic causal schema supports references to proposals in stages that create records. Resolution planning occurs before those records exist and enforces a narrower causal contract. The mismatch consumed bounded repair work and obscured the distinction between a correct action binding and an invalid cause.

## Timeline

- The initial response contained strict JSON, twelve slots and all thirty-eight required plans.
- Every plan's actionRef selected an existing action, while its causes referenced its own proposalKey.
- The plan schema accepted those references. The materializer correctly rejected them as unavailable existing evidence.
- Repair feedback named the plan and an action-reference failure without identifying the causes field. Some repairs recovered plans, but the root remained incomplete.
- The planning schema was aligned with the materializer's already-existing phase restrictions.
- The runtime regression exposed a second loss: a generic invocation audit overwrote the classifier's exact schema path. Repair now merges diagnostics for the same rejected invocation, preserves omitted evidence, and suppresses only redundant known wrapper errors.

## Root cause

The model plan schema reused the general causal-reference union. That union permits proposal references and check/random/mechanic evidence needed by other stages. The plan materializer instead resolves all causes as existing references and rejects those three post-plan kinds. Schema-valid fixtures with conventional action causes did not test the difference between advertised and executable evidence.

The repair loop assumed any nonempty provider audit was more precise than local classification. That assumption erased exact paths in the runtime test and original rejected values omitted by real slot audit projections. Neither source is universally more complete. Evidence is combined only for this invocation, with audit metadata taking precedence for matching code/path identities; substantive root diagnostics remain intact.

## Guardrails

The [stage-specific schema](../../src/engine/contracts/llm-schemas.ts) advertises existing action/event/fact/law causes only for resolution plans. It leaves proposal semantics elsewhere intact and explicitly describes the existing per-action means inventory. The [contract tests](../../src/engine/contracts/__tests__/resolution-plan-evidence-contract.test.ts) compare canonical and dependent wire schemas, reject unavailable causes at exact fields, and preserve valid values and other-stage proposals. [Runtime repair tests](../../src/engine/mechanics/__tests__/resolution-grounding-feedback.test.ts) verify the real error-to-repair path and replayed state. [The approved scope](../specs/0033-resolution-plan-evidence-contract.md) does not permit synthesizing evidence or treating this correction as demonstrated gameplay success.

[Repair boundary regressions](../../src/engine/models/__tests__/semantic-repair.test.ts) cover generic audits, generic classifiers, partial projections and substantive root issues. They prevent an informative rejection from becoming a generic repair request without changing the rejected output.
