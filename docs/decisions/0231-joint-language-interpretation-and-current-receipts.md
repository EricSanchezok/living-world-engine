# Joint language interpretation and current narrative receipts

## Status
Accepted
Class: architecture

## Context and Problem Statement

A player submission has dependent semantic fields: the chosen act determines which quantity, duration and continuation apply. Independent question semantics can select a resource from one side of an exchange and a quantity from the other. Narrative history supplies references but cannot override the newest executed result.

## Decision Drivers

- Coherent interpretation of compound requests, follow-ups and consent.
- Native decisions retain independent conditional questions.
- Current outcomes and self-inventory remain authoritative in player feedback.
- Avoid extra calls merely to reconcile answers that belong to one interpretation.

## Considered Options

- Use independent questions for every model and reconcile conflicting answers in extra calls.
- Give every runtime decision to a joint generative planner.
- Interpret player language jointly, bind native dependent parameters to explicit branches, and provide narration a current publication task.

## Decision Outcome

Choose the third option under [Spec 0184](../specs/0184-conversational-continuity-and-recovery.md). The player interpretation profile produces one consistent operation and continuation from the complete current request and settled receipts. Native independent decisions bind outgoing quantities to each candidate resource. Narration receives current observed receipts, already published text, first-appearance references and the player's authorized current holdings. World adjudication and transaction authority remain with their existing owners.

## Pros and Cons of the Options

- Reconciliation retains a uniform interface but adds requests after avoidable contradictions and allows the initial inconsistent result to influence interpretation.
- A universal generative planner handles dependencies directly but replaces efficient native decisions even for genuinely independent predicates.
- Separate instruction profiles preserve the typed interface and native batching while expressing the actual dependency structure. The publication task repeats a small set of critical current facts and requires tests that distinguish historical requests from executed effects.

## Links

- [Shared discourse](0230-shared-discourse-and-interaction-recovery.md)
- [Direct runtime](../game-design/direct-runtime.md)
- [Narrative contract](../game-design/narrative.md)
