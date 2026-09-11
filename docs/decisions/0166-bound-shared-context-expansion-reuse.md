# Bound shared context expansion reuse

## Status

Accepted
Class: architecture

## Context and Problem Statement

Physical truth requests pass through several reversible representation adapters. These adapters clone envelopes and repeatedly expand the same shared context, including its complete slot hashes and catalog-order checks. An object-identity cache misses cloned envelopes, while canonical content hashes ignore insertion order that can affect the serialized request.

## Decision Drivers

- Preserve exact request content, ordering, source bindings and slot isolation.
- Avoid repeated expansion work within a physical request's synchronous construction.
- Bound retained memory and avoid cache invalidation across asynchronous work.

## Considered Options

- Repeat complete expansion at every adapter boundary.
- Cache by envelope object identity or declared logical context hashes.
- Retain a cache for the entire asynchronous request with async context propagation.
- Memoize complete encoded envelope bytes only during synchronous construction.

## Decision Outcome

Use a bounded synchronous scope around the physical provider call in the truth batch coordinator. Fingerprint a detached binary serialization of the entire shared envelope, including codec, shared data, deltas, slot bindings and catalog orders. Cache only successful expansions as owned serialized bytes and deserialize a fresh result for every hit. Changed inputs reenter the existing validator. Each scope retains at most 32 MiB of result payloads and 64 entries, evicts the least recently used entries, and skips oversized entries.

The scope restores its predecessor in a synchronous finally block, including when construction throws or returns a Promise. It does not survive an HTTP wait. Nested construction owns a separate cache and restores its parent. Reuse has no model-visible configuration, does not change the canonical hashing contract, and never uses a similar action or an unchanged declared context hash as sufficient evidence.

## Pros and Cons of the Options

Repeated expansion is simple but duplicates large deterministic traversals. Identity caches are ineffective across cloned adapters; declared-hash caches can miss tampering and ignore wire order. An asynchronous cache supports more reuse but retains large contexts during network waits and requires additional lifecycle management. Synchronous byte-bound reuse covers request construction with explicit memory and lifetime bounds. Its tradeoff is serialization overhead and conservative misses: equal JavaScript values can have different binary encodings, which loses reuse without accepting a changed binding.

## Links

- [Efficiency experiment contract](../specs/0029-nonthinking-gameplay-efficiency-experiment.md)
- [Shared context implementation and validation](../../src/engine/mechanics/shared-batch-context.ts)
- [Truth batch construction boundary](../../src/engine/mechanics/truth-batch-provider.ts)
- [Mutation, isolation and lifecycle regressions](../../src/engine/mechanics/__tests__/shared-batch-context.test.ts)
- [Node.js serialization API](https://nodejs.org/api/v8.html#serialization-api)
