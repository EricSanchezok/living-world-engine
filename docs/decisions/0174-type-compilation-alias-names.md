# Type compilation alias names

## Status

Accepted
Class: architecture

## Context and Problem Statement

Action Compilation can select a valid request-local alias with the wrong record type. Agent, Entity and Action labels may refer to the same character while their field permissions differ. Generic ordinal aliases obscure this distinction at the point of selection. Schema guidance and a hosted strict flag do not establish sampling enforcement.

## Decision Drivers

- Preserve complete source actions, visible catalogs and exact record selection.
- Make an existing type distinction visible in each selected name.
- Retain original compiler authority and test the representation independently.
- Avoid guessing identity bindings or changing literal world content.

## Considered Options

1. Prefix every visible compilation alias with its actual catalog kind in an isolated experiment.
2. Use generic aliases with shared field-domain guidance.
3. Depend on hosted strict-tool constraints.
4. Convert a wrong-type choice into a similarly labeled record.

## Decision Outcome

The experimental adapter maps each complete visible alias to its catalog kind and original ordinal, such as `agent_r010` or `entity_r335`. It rewrites only projector-owned context reference fields, schema reference leaves and structured profile evidence. Output decoding visits each declared leaf once across overlapping schema branches. Prose, text facts, source strings and arbitrary random-result values retain their exact values. A wrong prefix, unknown alias or bare original ordinal is invalid; no corresponding record is inferred. The original AT schema, slot validator and compiler materialize the decoded result. Runtime defaults do not select this adapter. The [player action efficiency spec](../specs/0122-player-action-efficiency.md) owns experiment admission.

## Pros and Cons of the Options

1. Typed names place an existing distinction next to each choice and preserve an exact inverse. They increase token length and cannot guarantee semantic selection, valid structure or first-pass success.
2. Shared domains preserve all legal values and can complement typed names, but they leave the name itself opaque. Combining both treatments would obscure the first independent comparison.
3. A provider that actually enforces the complete contract could prevent formal errors. Capability controls and equivalent coverage of unsupported schema constructs are prerequisites; an accepted request is insufficient evidence.
4. Label-based conversion can resolve the wrong entity or hide an invalid choice. It changes semantics and violates exact source authority.

## Links

- [Typed alias adapter](../../src/engine/benchmarks/step-efficiency/typed-compilation-aliases.ts).
- [Shared field-domain decision](0173-share-compilation-field-use-domains.md).
- [Paired provider controls](../../scripts/experiments/deepseek-strict-tools-readiness.ts).
- [Compilation comparison](../../scripts/experiments/player-compilation-field-domains.ts).
