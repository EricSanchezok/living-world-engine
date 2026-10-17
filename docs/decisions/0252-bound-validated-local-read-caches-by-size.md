# Bound validated local read caches by size

## Status

Accepted
Class: bug-fix

## Context and Problem Statement

A fixed eight-instance cache repeatedly evicts every entry when nine active instances are polled in order. A miss reconstructs and verifies the complete immutable block graph. WorldHost also loads the pinned world definition for each read, repeating template parsing, construction and validation even when the world, seed and model catalog are identical. These synchronous operations compete with model streams and HTTP responses on the host event loop.

## Decision Drivers

- Preserve exact stored values, validation, caller mutation isolation and external-corruption detection.
- Retain a useful working set without unbounded process memory growth.
- Reuse only definitions whose complete inputs and rule runtime remain trustworthy.
- Change neither world state, model requests nor durable storage identities.

## Considered Options

1. Increase only the fixed instance count and continue rebuilding definitions.
2. Use bounded validated-document and exact-definition caches with independent invalidation checks.
3. Cache arbitrary immutable storage blocks across reads or remove repeated integrity checks.

## Decision Outcome

Choose validated root-level reuse. The instance LRU retains at most 64 entries and 128 MiB of serialized UTF-8 document bytes. A reader can lower the byte budget. An entry exceeding the budget remains readable and validated but is not retained. List reads fill unused capacity without evicting the entries already serving active reads. Cache hits and misses both emit one completed-read event without a payload. These byte counts bound retained serialized content; they are not a promise about JavaScript heap size.

World definitions use a separate 16-entry, 32 MiB serialized-content LRU whose byte budget can also be lowered. Its identity includes exact stored template bytes, world ID and content hash, normalized seed, model-catalog hash, and the selected rule-package references and trusted runtime identity. Core rule implementations support this trust boundary; custom registries rebuild because their validation closures may change without changing a declared package version. Definitions and instance documents returned to callers are independent mutable clones.

An external SQLite `data_version` change invalidates both caches. Instance generation and root hash are checked on every read; definitions additionally require the stored template bytes to match. Cold reads retain full content verification. Runtime-contract projection copies only the contract fields, excluding initial state and assets before cloning. No schema or algorithm producer changes are required.

## Pros and Cons of the Options

Raising only the entry count reduces one particular threshold failure, but large instances still have no byte bound and pinned worlds still rebuild on every request.

Validated root reuse removes repeated decompression and world construction while preserving existing validation on misses and invalidation. It retains additional memory, still clones returned values, and can miss under byte pressure or external writes. Custom rule runtimes deliberately receive no full-definition reuse.

A process-wide block cache could accelerate partial reconstruction, but introduces another lifetime and corruption-invalidation boundary inside the storage codec. Skipping integrity checks would weaken the existing persistence contract. Neither is needed to reuse an already validated root.

## Links

- [Local SQLite runtime](0041-local-sqlite-runtime.md)
- [Historical read-cache boundary](0049-world-run-failure-and-stream-boundaries.md)
- [Local database](../../src/server/local-database.ts)
- [Runtime-contract projection](../../src/engine/runtime/world-definition.ts)
- [Read-cache regressions](../../src/server/__tests__/local-database-cache.test.ts)
- [Read amplification incident](../postmortems/0177-local-read-cache-thrashing-stalled-gameplay.md)
