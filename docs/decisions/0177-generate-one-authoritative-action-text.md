# Generate one authoritative action text

## Status
Accepted
Class: architecture

## Context and Problem Statement

AgentMind authors an action as independent raw text, goal and means strings. Shape validation cannot establish that those strings describe the same undertaking. The [scope instruction experiment](0176-keep-agent-action-texts-in-one-scope.md) preserves this redundant choice. A desired result can legitimately span time or motivate a smaller step, so textual differences alone do not prove an invalid action.

## Decision Drivers

- Preserve open, compound, conditional and continuing intentions and private strategic goals.
- Remove independent paraphrases at the action producer before adding semantic critic calls.
- Test new generation through the actual cognition boundary without rewriting historical intent.
- Keep downstream adjudication, canonical validation and experiment provenance explicit.

## Considered Options

1. Generate one complete action text and embed it in the existing canonical action for a bounded experiment.
2. Retain three independently generated texts with stronger consistency instructions.
3. Replace the entire persistent action contract before testing the new producer.
4. Infer a corrected action by dropping or reconciling historical goal and means fields.

## Decision Outcome

The experimental single-text producer returns `rawText` and the original `targetHandles`. The text expresses the complete intended attempt, including its desired result or maintained condition and specified method. Its decoder copies that exact text into canonical `rawText` and `goal`, and sets `means` to null, the same embedding used by external player input. The canonical fields contain one authored statement; no separate semantic interpretation is generated. All other outputs, private source context, validators and physical batch membership remain intact. Unexpected old action fields are rejected rather than discarded. Adjudicated ResolutionPlan goals and means remain model-owned downstream semantics, and private character goals remain private state.

This contract is confined to the benchmark boundary. It is not an equivalent codec for historical triplets, a save migration or a promoted runtime contract. Synthetic offline fixtures include every original action text and verify exact new text materialization, while baseline replay retains historical byte and normalization equality. The [player efficiency contract](../specs/0122-player-action-efficiency.md) owns prospective model and player qualification.

## Pros and Cons of the Options

1. One text removes independently authored action paraphrases with no extra inference and uses the existing external-input representation. Free prose can still omit intent, invent knowledge or remain ambiguous; source review and downstream validation remain necessary. Canonical duplication is retained only by the bounded experimental embedding.
2. Three texts expose goal and method separately, but require the model to keep their scopes consistent and can substitute a strategic private goal for the selected next action.
3. A persistent-contract replacement removes canonical duplication but changes more boundaries before evidence establishes that the new producer preserves useful intent. It is a separate forward-only decision after source and downstream qualification.
4. Reconciliation can conceal contradictions or lose genuine exclusive intent. It is not a source-preserving operation and does not test the new producer.

## Links

- [Single-text adapter](../../src/engine/benchmarks/step-efficiency/agent-action-text.ts).
- [AgentMind comparison](../../scripts/experiments/player-agent-action-scope.ts).
- [External action construction](../../src/server/world-host.ts).
- [AgentMind materialization](../../src/engine/algorithms/eager-reference/agent-mind.ts).
