# Scope Local Information Identifiers to Their Owner

## Status

Accepted
Class: architecture

## Context and Problem Statement

A private local entity ID is a key within one Agent's belief namespace. Treating that bare key as globally protected prose makes an unrelated Agent's alias such as `keep` prohibit the ordinary phrase "keep watch". Exact word boundaries cannot resolve this identity mismatch.

## Decision Drivers

- Preserve arbitrary natural-language observation and independent local namespaces.
- Reject foreign qualified references and copied private content.
- Avoid world-specific word exceptions or disabling information-boundary validation.

## Considered Options

1. Ban every foreign bare alias in all public prose.
2. Maintain a dictionary of common-word exceptions.
3. Protect local entity identifiers in their owner-qualified reference form.
4. Remove the public-information guard.

## Decision Outcome

Choose owner-qualified local references. The public-information guard protects `ref:local_entity:<owner>::<alias>` for another Agent's local entities and local-entity-valued claims. A matching bare word alone does not establish access to that private entity. The observer's own bare alias never authorizes a different owner's qualified handle. Canonical identifiers, private descriptions and private fact text retain their existing checks; structured observation references still pass the authoritative observer-scoped materializer.

This is a namespace correction, not an automatic proof that arbitrary prose preserves knowledge isolation. The literal guard remains finite evidence, alongside reference validation, source-bound semantic inspection and the engine's separation of truth from beliefs.

## Pros and Cons of the Options

Global alias bans mistake unrelated vocabulary for private identity. A common-word dictionary would depend on language and world-specific content, while removing the guard would also discard useful private-content checks. Qualified identifiers match the existing observer reference contract and avoid those collisions, but natural-language disclosures still require semantic evidence beyond literal token matching.

## Links

- [Observation reference construction](../../src/engine/cognition/observation-renderer.ts)
- [Namespace and private-content regressions](../../src/engine/cognition/__tests__/information-boundary.test.ts)
- [Incident](../postmortems/0055-private-aliases-became-global-vocabulary-bans.md)
