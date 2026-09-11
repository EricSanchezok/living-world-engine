# Check private information by source relation

## Status

Accepted
Class: architecture

## Context and Problem Statement

The observation guard aggregates private scalar values and bare cognition record keys into globally forbidden text. An ordinary activity status can match an unrelated expedition's private status, while an ordinary preservation statement can match another Agent's value-record key. These lexical equalities do not identify a disclosed fact or private record.

## Decision Drivers

- Preserve arbitrary local vocabulary without world-specific exceptions.
- Detect actual protected identities and explicitly represented private fact relationships.
- Keep source meaning and cognitive isolation independent of representation compression.
- Reduce false repair without adding model calls or treating mechanical admission as semantic proof.

## Considered Options

1. Identify private cognition by typed references and private scalar facts by subject, predicate and value.
2. Keep global scalar matching with a common-word allowlist.
3. Drop the observation information boundary entirely.

## Decision Outcome

Choose source relations. The guard distinguishes an ordinary scalar from the particular fact that assigns that scalar to a subject and predicate. Cognition record keys use the existing typed reference constructor instead of bare words. Complete private descriptions, qualified local references and canonical identifiers retain literal protection. The [source-scoped disclosure spec](../specs/0123-source-scoped-observation-disclosure.md) owns the contract and its limits. Independent causal review owns open-language attribution and semantic validity; exact lexical matches never constitute a general noninterference proof.

This extends the source-ownership reasoning in [decision 0114](0114-owner-scoped-local-information-identifiers.md) to private record keys and scalar facts. No historical failed sample is reclassified as a successful experiment.

## Pros and Cons of the Options

1. Exact identity and relationship checks have a concrete source witness and avoid unrelated scalar collisions. Paraphrased or implicit relationships remain semantic judgments, and explicit ambiguous bindings cannot be resolved by guessing.
2. A vocabulary list depends on language and world content, cannot enumerate arbitrary valid prose, and retains the incorrect global ownership assumption.
3. Removing all checks would discard useful deterministic protection for foreign references and directly copied private descriptions.

## Links

- [Guard implementation](../../src/engine/cognition/information-boundary.ts).
- [Source relation regression](../../src/engine/cognition/__tests__/information-boundary.test.ts).
- [Using Architecture to Reason About Information Security](https://doi.org/10.1145/2829949) motivates reasoning about domains, causal information flow and trusted-component properties; it does not prove this language-model implementation secure.
