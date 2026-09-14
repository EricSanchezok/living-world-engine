# Author Speech at the Source

## Status
Accepted
Class: testing

## Context and Problem Statement

Perception paraphrases can exchange speaker and observer or treat a future message as delivered. An explicitly chosen utterance can retain its words and actor independently of its intended effects. The [intent-program screen](../specs/0161-agent-intent-program-screen.md) exposes a full control tree with untrusted conditions; a source speech primitive has a smaller semantic responsibility.

## Decision Drivers

- Bind the speaker from the actual source actor.
- Preserve exact utterance content without asserting its truth or effects.
- Keep unrestricted actions and complete private decision evidence.
- Separate message production, delivery and belief revision.

## Considered Options

- Reconstruct speech and recipients from free-form actions downstream.
- Generate a general intent program.
- Offer source-authored current speech alongside unrestricted open actions.
- Treat agent messages as automatically delivered belief updates.

## Decision Outcome

Use the isolated [source-authored speech screen](../specs/0163-source-authored-speech-screen.md). The author chooses open or speak. A deterministic proposal descriptor exposes code-bound speaker identity and exact speech content, with unadjudicated delivery. Existing canonical action validation remains required.

## Pros and Cons of the Options

Downstream reconstruction preserves an existing source but can misread roles or timing. A general program handles more control structure while increasing output and requiring an interpreter for open conditions.

A speech primitive removes a redundant paraphrase for choices it represents completely. It does not cover arbitrary simultaneous physical work, prove audibility, or guarantee rational choices. The unrestricted open branch preserves those actions and may still dominate actual use.

Automatic delivery and belief updates are efficient under an explicit communication infrastructure. They violate a situated world when location, concealment, missing delivery, distrust and cognition ownership are unresolved.

## Links

- [On the Formal Semantics of Speech-Act Based Communication in an Agent-Oriented Programming Language](https://doi.org/10.1613/jair.2221), sections 3–4, distinguishes outgoing and incoming messages with identifiers and performatives. Its transport is assumed infrastructure, and its belief-update semantics is specific to AgentSpeak; neither is adopted as a physical-world guarantee here.
- [Jason ACL performatives](https://jason-lang.github.io/jason/tech/performatives.html) documents sender-annotated tell and signal behavior. This experiment adopts neither automatic belief insertion nor trusted message truth.
- [Paired perception demonstrations](../specs/0162-paired-perception-demonstration-screen.md) retain downstream free-form report generation.
