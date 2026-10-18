# Complete-world property choices exceeded the decision bound

Artifact-Version: 1

## Executive summary

The first live qualification of the complete Fanren world stopped before settlement because a textual property's existing alternatives exceeded the decision protocol's 255-option limit. World import, origin initialization and small-population execution had passed, but none exercised the complete property's value domain. The failure preserved canonical quantities and replayability; it did not qualify gameplay.

## Summary

Instance `f09a88ed-ae36-43d8-b8d2-b75473e05e89`, execution `0231296d-45ec-4621-a582-d918ac7d7c3b`, loaded 852 Agents under producer 15. Its player interpretation and four nearby NPC interpretations completed, but world preparation rejected `questions.a2_fact1.criteria` and `questions.a3_fact0.criteria` before a world decision could be sent. No physical action committed. The bounded run used six HTTP POSTs, including initial narration, with 89,781 input and 9,090 output tokens. Failed qualification remains part of the cost record.

The saved source fingerprint, execution events and final state establish this boundary. Subsequent narrative cancellation followed the harness stopping dispatch after the world failure; it was not the initiating defect.

## Timeline

1. The complete package passed import, all nine origin initializations, relationship checks and local replay checks.
2. A bounded Flash run submitted a request to a merchant's manager with free world expansion disabled.
3. The Ledger recorded accepted player and NPC interpretations, followed by local decision-schema rejection in world preparation.
4. Source inspection found 792 distinct learned-skill values and 435 distinct travel-condition values in the complete world, before reserved and ordinary-state options were added.
5. A regression through real action preparation and the decision gateway reproduced the capacity failure without paid inference.
6. Nineteen focused tests passed after the lossless grouping fix; a final selected-key validation increment passed separately. Producer 16 pins the new representation.

## Root cause

World settlement builds a text property's finite choices from same-predicate values across the world. The candidate count can therefore exceed the wire limit even when only a few nearby people act. Schema validation correctly rejected the oversized question; preparation had incorrectly assumed the domain would fit. Import and origin tests do not construct settlement questions, and smaller runtime fixtures did not cross the limit. Prior 150- and 700-person probes could not establish complete-package execution.

Dropping candidates would change valid world semantics. Sending overflow through open-value creation would also change behavior: finite existing values are selectable with creation disabled, while authoring an unlisted value requires separate permission. Increasing the generic limit would conflict with the native decision protocol.

## Guardrails

[Property-value regressions](../../src/engine/direct/__tests__/property-values.test.ts) exercise the real preparation and decision path with oversized domains, exact tail selection, unchanged values and the creation-disabled boundary. [Decision 0266](../decisions/0266-group-large-finite-property-choices-within-one-batch.md) retains the lossless same-batch encoding choice and its tradeoffs. The provider's existing per-question bound remains enforced.

Full-world acceptance must include execution against the final package and report loaded population separately from actual acting subjects. A successful import, a smaller scale probe or an unchanged replay cannot stand in for that evidence. The [complete-world specification](../specs/0196-canonical-world-and-participation-seeds.md) owns that acceptance requirement.
