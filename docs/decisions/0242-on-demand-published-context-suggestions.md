# Request suggestions from published context on demand

## Status
Accepted
Class: architecture

## Context and Problem Statement

Suggestions are optional presentation work. Automatic generation adds a delayed batch to every decision point even when the player already has an action in mind. A character's authorized location description can contain names absent from the published conversation, so a perspective-safe suggestion can still assume introductions the player has never received.

## Decision Drivers

- Let the player choose when to request help and whether to replace it.
- Keep suggestion references grounded in the conversation the player has read.
- Preserve responsive input, one producer and durable request evidence.
- Reduce unnecessary reasoning without changing the bound model or world execution.

## Considered Options

- Keep automatic batches and hide their latency behind placeholders.
- Couple suggestions to narration and reuse its output.
- Generate independently only on an explicit request, with published context and task-specific inference intent.

## Decision Outcome

Choose explicit request and replacement under [Spec 0190](../specs/0190-on-demand-action-suggestions.md), superseding [0241](0241-independent-contextual-action-suggestions.md). Source identity fences the scene; request identity and compare-and-swap fence replacements. A replacement retains the previous batch until success. The model sees published conversation and own goals, with no raw perspective catalog or unpublished descriptions. Trusted inference overrides disable reasoning on the same pinned creation model; the gateway validates capability and records effective settings in the request hash, audit and probe.

## Pros and Cons of the Options

- Automatic batches provide help without a click but spend model work on unused content and interrupt the reading rhythm when results arrive.
- Coupling to narration can share a call but ties optional assistance to prose publication and still needs another path for refresh and direct dialogue.
- Explicit generation makes timing intentional, avoids unused inference and supports replacement through one worker. It requires a discoverable control and makes the player wait after clicking. Published-only context limits referents, while own goals still guide useful directions. A supported reasoning override reduces computation without selecting a second model or weakening world adjudication.

## Links

- [Presentation contract](../game-design/presentation.md#情境行动建议)
- [Model gateway](../game-design/model-gateway.md)
- [Regression coverage](../../src/server/__tests__/suggestions.test.ts)
