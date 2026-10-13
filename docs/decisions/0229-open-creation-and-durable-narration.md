# Open creation and durable participant narration

## Status
Proposed
Class: architecture

## Context and Problem Statement

Direct execution is fast, but fixed dialogue and observation-summary projection constrain expression. Expanding prose alone cannot make invented objects interactive or give NPCs varied agency.

## Decision Drivers

- Natural, varied and persistent world interaction.
- Private cognition and exact delivered speech.
- Low latency without per-event writing or repeated generation on reads.
- Recoverable presentation and auditable cost.

## Considered Options

- Retain fixed templates and paraphrase the completed turn.
- Let one omniscient storyteller generate both world changes and prose.
- Create actions and new world content before adjudication, then narrate authorized committed scenes through a durable outbox.

## Decision Outcome

Choose the third option, as specified in [Spec 0183](../specs/0183-open-actions-immersive-narrative.md). Jev retains semantic decisions and code retains mechanical commits. DeepSeek creates private expression, authorized local expansion and participant prose at separate input boundaries. Persisted scene segments survive reconnect and restart. The request mix is measured rather than constrained by a Jev percentage target.

## Pros and Cons of the Options

- Templates plus paraphrasing is cheap but retains limited behavior and cannot support new interactive content.
- One omniscient storyteller offers expressive freedom but collapses cognition, speech delivery and world authority into prose.
- Separate creation and durable narration preserves those boundaries and supports streaming and recovery, at the cost of more creation requests and presentation state.

## Links

- [Direct runtime decision](0228-jev-direct-world-runtime.md)
- [Game first principles](0004-game-first-principles.md)
- [DeepSeek streaming API](https://api-docs.deepseek.com/api/create-chat-completion/)
