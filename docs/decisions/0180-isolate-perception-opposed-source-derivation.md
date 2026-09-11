# Isolate Perception Opposed Source Derivation

## Status
Accepted
Class: simplification

## Context and Problem Statement

Canonical perception requires an opposed difficulty to cite its selected Rating as an identical source. The assessment protocol removes this functional dependency from model generation, but also changes verdicts, evidence, task binding and context. Its failed qualification does not isolate the source derivation itself.

## Decision Drivers

- Eliminate an independently generated value with exactly one valid interpretation.
- Preserve every independent semantic choice and original rejection boundary.
- Reuse the existing derivation without promoting a failed combined protocol.

## Considered Options

- Repeat the equality instruction and repair inconsistent sources.
- Promote the complete assessment or owner-choice protocol.
- Isolate source derivation in an optional canonical perception transport.

## Decision Outcome

The benchmark transport selects the third option. Both comparison arms omit the generated JSON example; only the treatment omits the opposed source field. A shared decoder reconstructs that field from the selected Rating before original canonical validation. It refuses extra fields and does not infer the intended owner or ability. The default runtime does not select the candidate; the [diagnostic contract](../specs/0127-perception-derived-source-diagnostic.md) owns empirical acceptance.

## Pros and Cons of the Options

Repeating instructions retains a redundant failure opportunity. Promoting a combined protocol ignores its unresolved source-semantic failures. Isolated derivation eliminates one representational contradiction and reuses existing logic, but changes the physical prompt and cannot establish which checks are justified or which Rating applies. It still requires complete-source evaluation.

## Links

- [Perception numeric authority](../specs/0103-derive-perception-check-numbers.md).
- [Assessment implementation](../../src/engine/benchmarks/step-efficiency/perception-assessment.ts).
- [Owner-bound choices](0161-select-perception-ratings-with-their-owners.md).
- [Example isolation](../specs/0126-perception-example-diagnostic.md).
