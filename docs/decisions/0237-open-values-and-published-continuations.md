# Bind open values and published continuations

## Status
Accepted
Class: architecture

The existing-text creation boundary is superseded by [decision 0251](0251-action-bound-values-outside-reusable-capabilities.md). The movement and narrative continuation decisions remain in force.

## Context and Problem Statement

Finite action parameters and property candidates can fail to express an otherwise ordinary attempt. Published paragraphs create a separate irreversible boundary: restarting prose generation must not replay already presented results. The [continuity regressions](../research/2026-10-14-conversation-continuity-regressions.md) identify both failures through actual execution and narrative evidence.

## Decision Drivers

- Preserve the requested operation and the identity of existing properties.
- Allow open qualitative changes without generating full action programs.
- Preserve published text and exact delivered dialogue during bounded recovery.
- Account for additional generation and admission work.

## Considered Options

- Substitute searches or generic property values when finite parameters are missing.
- Generate full effects and an entire scene afresh for every action.
- Repair active bindings, request missing qualitative values explicitly, and continue from published text.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). Missing movement targets use bounded binding repair; only explicit discovery can introduce a preparatory search. The world decision can request a new text value for a particular existing property. The ordinary capability creator fills that subject/predicate effect and local adjudication admits it. Numeric resources, time and transaction validation retain their owners.

Narrative publication compares complete paragraphs against the current saved prefix. A wholly redundant continuation is omitted; a paragraph mixing repeated and new information requires the bounded correction. Ordered string arrays are normalized without semantic generation, while nontext entries remain invalid. The same closed evidence checks, exact dialogue and immutable segment ordering remain authoritative. Private goals enter only their owner's ScenePacket and do not establish accomplished effects.

## Pros and Cons of the Options

- Substitution avoids a correction request but changes player intent or leaves stale state.
- Full regeneration handles open text at the cost of repeated work, extra calls and duplicated presentation.
- Targeted open values and continuation checks preserve explicit boundaries and reuse existing mechanisms. They add semantic choices whose reliability and latency require the same frozen end-to-end qualification; deterministic checks alone do not establish quality.

## Links

- [Direct runtime](../game-design/direct-runtime.md)
- [Narration](../game-design/narrative.md)
- [Frozen evaluation protocol](../research/2026-10-14-conversation-continuity-protocol.md)
