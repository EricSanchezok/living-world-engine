# Group large finite property choices within one batch

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

Direct settlement proposes existing textual property values from the complete world. The decision contract permits at most 255 choices per question. A complete world can exceed this limit even when only a few nearby people act. Its finite values remain valid when free world expansion is disabled; routing overflow through open-value authoring would change that permission boundary.

## Decision Drivers

- Preserve every finite value, exact materialization, and the established expansion permission.
- Keep the provider's strict choice bound and a single settlement dispatch.
- Preserve the current small-domain request shape and avoid truncating the world or candidate domain.

## Considered Options

- Raise the generic choice limit.
- Restrict candidates to a local subset or truncate them.
- Route overflow to open property authoring.
- Encode large finite domains as bounded groups in the same decision batch.

## Decision Outcome

Use bounded groups for an overflowing finite domain. All concrete values and their stable keys remain in the request. The root selects an unchanged value, an authorized open-value request, or a group; its corresponding subordinate choice resolves the exact finite value. Group questions are conditional judgments included in the same batch. Small domains retain their direct choices. Only the selected path is decoded; an incomplete selected path fails, while unselected branches cannot cause an effect. Encoding and decoding own the representation; the existing effect, visibility, resource, and transaction paths remain authoritative.

## Pros and Cons of the Options

Raising the limit conflicts with the native decision protocol. A local subset can omit a legitimate value and changes the meaning of the candidate catalog. Open property authoring requires a separate permission and can add a model call. Same-batch grouping preserves the finite domain and dispatch count, at the cost of more conditional questions and model output. It is a capacity correction, not evidence of lower total token cost or equivalent semantic quality; local boundary tests and bounded live qualification provide those separate measurements.

## Links

- [Approved complete-world contract](../specs/0196-canonical-world-and-participation-seeds.md)
- [Direct world settlement](../../src/engine/direct/world.ts)
- [Property value regression tests](../../src/engine/direct/__tests__/property-values.test.ts)
- [Decision protocol](../../src/engine/models/decision-v2.ts)
