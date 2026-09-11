# Gateway rejection hid independent perception errors

Artifact-Version: 1

## Executive summary

The gateway rejected unknown perception references before the Truth Engine could collect independent task and Rating ownership errors. An already-invalid aptitude assignment survived two paid repairs because the feedback first exposed only unrelated unknown references.

## Summary

The fresh 49-Agent `integrated-player-07` diagnostic stopped without player feedback or a world step. All three perception responses assigned King Graptar's insight Rating to King Ragnar in request 17. The first response also invented three other Ratings, and the first repair retained two of those unknown references. The gateway rejected both candidates before draft-relation validation ran. Only the final repair reached the existing owner check, exhausting the two-repair allowance. The retained world gives Ragnar command, force, influence and resolve, and does not authorize borrowing Graptar's insight.

## Timeline

- Instance `973d9a1f-3168-40fe-9e60-644d68d6776a`, preparation execution `902544e8-8dd6-4873-9dd9-00196eb57147`, preserved all 25 HTTP responses and their audits.
- Parsed perception candidates at Ledger sequences 411, 425 and 439 contain the same incorrect request 17. Unknown-reference diagnostics at 412 and 426 precede ownership rejection at 443 and execution failure at 445.
- The player measurement stopped after 102.856 seconds with no feedback or Activity. This run did not reach the earlier boundary-interruption correction and provides no performance qualification for it.
- A real gateway regression combined an unknown Rating with independent owner and task errors. The old implementation returned only the unknown-reference feedback; schema-invalid output served as a separate control.

## Root cause

The complete relation diagnostics introduced by the [perception contract](../specs/0107-validate-perception-task-relations.md) ran only after a successful provider return. Existing tests exercised multiple relation and materialization errors with resolvable references, leaving the earlier gateway rejection path uncovered. The semantic repair loop preserved detailed gateway issues, but had no caller-supplied diagnosis of the schema-valid rejected value.

## Guardrails

Truth Engine adds its existing pure perception-relation diagnostics when classifying a provider rejection whose original candidate still passes the canonical schema. It preserves that rejection and its reference issues. It does not materialize the rejected candidate, choose new values, draw randomness or increase repair limits. Other roles and schema-invalid values do not use this diagnosis. Onset-perception version 5 identifies the revised feedback behavior; execution acceptance remains unchanged.

The [gateway regression](../../src/engine/mechanics/__tests__/perception-references.test.ts) checks combined feedback in the first physical repair, original candidate and usage retention, identical clean/repaired checks and RNG, and unchanged source state. A malformed candidate must not receive invented relation diagnostics. Existing owner, task, opposed-source and commitment checks remain authoritative. New model recovery and first-pass semantic success still require independent evidence.
