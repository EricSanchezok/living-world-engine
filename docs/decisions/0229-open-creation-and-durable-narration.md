# Open creation and durable participant narration

## Status
Accepted
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

Development probes exposed invented props, actions and altered dialogue. The publication boundary therefore checks complete paragraphs against the frozen scene, preserves literal dialogue by reference, and uses the existing one-continuation recovery budget on factual rejection. DeepSeek owns this text comparison because Jev missed material differences in complete prose. Jev still admits world changes. Player exploration invites small persistent drafts, including an explicit empty draft when existing content suffices, rather than making creative discovery depend on interpreting absence in the initial catalog. These choices add request cost and do not replace independent human evaluation of the final text.

Player free-form interpretation uses the pinned DeepSeek decision profile when creation is enabled. This retains one typed action-selection request while giving conditional consent, compound instructions and linguistic limits to the stronger language interpreter. Native-only interpretation produced false waits after repeated matching offers in continuous play. Jev retains autonomous action selection and world adjudication. The cost is a larger DeepSeek request share and measured interpretation latency; creation-disabled ordinary-action experiments retain native interpretation. The narrator receives executed observations without the original compound request, preventing an unperformed later instruction from becoming apparent scene evidence.

The language-model wire carries only selected keys and numbers. Code reconstructs answer types from the questions. Repeating type labels adds no decision information and creates avoidable serialization failures; native provider diagnostics keep their original representation.

New-content coverage shares the existing admission request. It identifies undeclared people and independent props in appearances or events, allowing one targeted correction instead of leaving narrative-only objects. This adds no request to a complete draft and shares the structural repair limit. Invalid generated decision fields receive one field-scoped correction; keeping independent valid answers reduces repeated work without accepting an invalid reference.

## Pros and Cons of the Options

- Templates plus paraphrasing is cheap but retains limited behavior and cannot support new interactive content.
- One omniscient storyteller offers expressive freedom but collapses cognition, speech delivery and world authority into prose.
- Separate creation and durable narration preserves those boundaries and supports streaming and recovery, at the cost of more creation requests and presentation state.

## Links

- [Direct runtime decision](0228-jev-direct-world-runtime.md)
- [Game first principles](0004-game-first-principles.md)
- [DeepSeek streaming API](https://api-docs.deepseek.com/api/create-chat-completion/)
