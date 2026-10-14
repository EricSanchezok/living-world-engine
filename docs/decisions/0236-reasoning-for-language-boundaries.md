# Use low reasoning for language boundaries

## Status
Accepted
Class: architecture

## Context and Problem Statement

The frozen continuity regressions contain repeated errors in shortened questions, corrections, action versus dialogue, attribution and evidence-grounded prose. Joint schemas, receipt projections and prompts are necessary but do not by themselves establish reliable language interpretation. DeepSeek Flash supports an explicit reasoning toggle and low effort through the existing Chat adapter. The chosen mode is an experimental producer configuration whose quality must be measured, not inferred from provider claims.

## Decision Drivers

- Improve coherent interpretation and expression across multi-turn context.
- Preserve Jev for autonomous choices and local world adjudication.
- Keep the fixed model identity, complete usage records and user-authorized budget.
- Measure feedback latency rather than assuming more reasoning is free.

## Considered Options

- Keep all semantic language calls in non-thinking mode and add more prompt constraints.
- Add a separate language critic after every interpretation and creation.
- Enable low reasoning on the existing DeepSeek decision and creation profiles.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). `decision-deepseek` and `creation-deepseek` use `deepseek-flash`, thinking enabled and effort low. These profiles cover coherent player interpretation, explicit decision fallback, dialogue, open creation, narration and its publication judgment. Jev retains its native decision profile. Legacy Truth and AgentMind profiles keep their own inference configuration. Instance snapshots pin the complete configuration and prompt identities.

Reasoning content is transport evidence, not a world event or published story paragraph. Existing terminal usage and unknown-fee handling include all provider work. The same frozen corpus, quality rubric, timing measurements and budget remain authoritative. Enabling this mode does not establish the qualification target or permit extra paid calls beyond the grant.

## Pros and Cons of the Options

- Non-thinking mode minimizes generation work but repeated prompt and schema refinements leave unresolved semantic errors in the recorded regressions.
- A separate critic gives another opportunity to catch errors but adds a mandatory request and a second handoff on every language operation.
- Low reasoning uses the existing request boundary and supports explicit producer comparison. It can increase output usage and latency, and may still make semantic mistakes; full real evaluation remains required.

## Links

- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Regression evidence](../research/2026-10-14-conversation-continuity-regressions.md)
- [Model gateway](../game-design/model-gateway.md)
