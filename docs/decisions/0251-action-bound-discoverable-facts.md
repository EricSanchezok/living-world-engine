# Action-bound discoverable facts

## Status
Accepted
Class: architecture

## Context and Problem Statement

Public facts can enter a known subject's perspective immediately. Private facts are deliberately excluded from observation even when a semantic visibility decision says otherwise. Neither policy represents an unknown physical property that a legitimate examination can reveal. The canonical-world task requires exactly this behavior for aptitude testing.

## Decision Drivers

- Preserve the distinction between latent world truth and private cognition.
- Reveal an existing value only through an actual admitted action.
- Retain fallible, time-specific knowledge without turning discovery into permanent access to live truth.
- Keep world rules in scripts and preserve deterministic replay.

## Considered Options

- Make latent properties public and rely on prose to say they are unknown.
- Change private facts to an Agent-access list after examination.
- Add a discoverable fact policy with an authored condition and actor-local observation.

## Decision Outcome

Use a discoverable policy. The world adjudicator evaluates its condition within the existing visibility decision; perception records the exact existing fact only for the successful actor. The canonical access policy does not change. Discovery adds no model call or second truth representation.

## Pros and Cons of the Options

Public properties require no new schema but leak before examination. Adding the examiner to an access list avoids that initial leak but makes future values silently available and confuses observation with an ongoing information grant. Discoverable properties preserve initial ignorance and historical belief; they require an explicit authoring condition and currently qualify through the direct-world observation path.

## Links

- [Action-bound discovery contract](../specs/0197-action-bound-fact-discovery.md)
- [Private information checks](0172-check-private-information-by-source-relation.md)
- [Origin initialization](0248-origin-admission-as-an-authored-transaction.md)
- [Direct perception](../../src/engine/direct/perception.ts)
