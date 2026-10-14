# Shared discourse and explicit interaction recovery

## Status
Proposed
Class: architecture

## Context and Problem Statement

An observation projection identifies world objects, while readable prose establishes what a player can refer to in conversation. Passing only recent observations to the interpreter and independent text snippets to the narrator leaves that referential relationship implicit. Generic failed-turn text also conflates rejected attempts with unavailable model service.

## Decision Drivers

- Continuous natural conversation and stable references across reloads.
- Cognitive isolation and canonical state authority.
- Understandable partial outcomes and bounded service recovery.
- World time appropriate to the participant's actual interaction.

## Considered Options

- Add phrase substitutions and more examples to separate prompts.
- Give every model a complete omniscient transcript and let it infer identity and state.
- Share a participant-scoped discourse projection with typed outcome and recovery records.

## Decision Outcome

Propose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). Published text, local entity references and actual speech provide the shared presentation context. Canonical bindings and other minds remain owned by their existing boundaries. An explicit outcome distinguishes semantic results, unresolved components and service status; narration explains the former, while code accurately exposes the latter. Interactive time progression uses a bounded horizon instead of inferring permission from an empty action queue.

## Pros and Cons of the Options

- Phrase substitutions are cheap but cannot resolve whether a person was introduced or which request a reply answers.
- An omniscient transcript simplifies context assembly but leaks hidden information and allows literary claims to masquerade as committed facts.
- A shared discourse projection supports stable references and recovery with bounded context. It costs persistent presentation metadata and requires publication, interpretation and perception to agree on local identity.

## Links

- [Open creation and durable narration](0229-open-creation-and-durable-narration.md)
- [Narrative contract](../game-design/narrative.md)
