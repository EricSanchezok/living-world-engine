# Local read-cache thrashing stalled gameplay

Artifact-Version: 1

## Executive summary

Real-model acceptance opened more active instances than the local eight-entry cache could retain. Repeated instance polling reconstructed entire compressed documents and rebuilt the same world definition. The host accumulated heavy garbage collection and development-time async stack work, and ordinary read requests stalled while model work remained active. Bounded caches now retain a larger byte-limited working set and reuse exact validated world definitions. Storage verification and caller mutation isolation remain enforced.

## Summary

The affected acceptance run had 21 retained instances, including nine actively driven or inspected sessions. Initial conversations remained at revision zero for several minutes. One read-only HTTP inspection timed out after ten seconds. A native sample and a JavaScript CPU profile identified local JSON-block hydration, canonicalization, cloning and world-definition construction; garbage collection accounted for 1,336 of 3,470 JavaScript profile samples. Development instrumentation added stack collection around repeated compression-resource creation. These samples established local pressure, not the complete timing of each outstanding model request.

A separate read-only process reproduced the capacity cliff without any model calls. With a stable database `data_version`, eight cached documents read in 299 ms with zero block hydrations; nine documents read in 6,106 ms with nine full hydrations. Repeated definition loads took 147–164 ms each. These are incident observations on one machine, not CI latency thresholds. Completed model audits separately reported nonzero provider execution and zero queue wait; unfinished buffered events did not establish a provider or queue cause.

## Timeline

- On 2026-10-17, funded real-model origin acceptance exposed long first-turn waits and unresponsive local reads.
- Ledger inspection separated completed transport durations from active invocations. Trace event timestamps were recognized as persistence-time stamps, so gaps between buffered events were not treated as network or queue measurements.
- Process sampling identified local read and allocation pressure. An independent read-only cache probe reproduced the eight-to-nine-instance threshold and repeated definition reconstruction.
- Test clients stopped, active instances were paused through the normal API, and the server stopped before production source changes. A separate temporary checkout held the patch and focused tests.
- Regressions exercised a nine-instance warm working set, byte and count limits, oversized-entry bypass, mutable return values, source corruption, seed and catalog changes, and custom validation closures.

## Root cause

The cache was bounded only by a small entry count. Sequential demand just above that count evicted the document needed by the next request, turning every request into a miss. Each miss synchronously inflated immutable blocks, recomputed their hashes and validated the complete instance. List requests also repeatedly reconstructed entries outside the retained set. Existing storage tests covered integrity and rollback but did not exercise a real working set exceeding the cache count.

WorldHost checked its pinned runtime contract through repository loading on ordinary reads. The local repository reconstructed the same validated world every time. Runtime-contract projection additionally cloned the full initial state and assets before deleting them. The combination produced allocations and synchronous work unrelated to the player's current action. Development instrumentation amplified this cost; disabling observability would have hidden the pressure without removing these unnecessary reads.

## Guardrails

- [Decision 0252](../decisions/0252-bound-validated-local-read-caches-by-size.md) owns cache identity, byte/count limits, custom-runtime exclusion and invalidation.
- [Local database regressions](../../src/server/__tests__/local-database-cache.test.ts) use actual instance creation and database reads, count block hydration rather than asserting machine-specific timing, and verify mutation isolation, oversized bypass, eviction, external corruption, seed/catalog isolation and custom-validator changes.
- [Immutable block tests](../../src/server/__tests__/json-block-store.test.ts) continue to reject missing, changed and reordered blocks. [Instance host tests](../../src/server/__tests__/world-instance-host.test.ts) retain rollback and warm-cache corruption coverage.
- [Runtime-contract projection](../../src/engine/runtime/world-definition.ts) excludes state and assets before cloning; its regression compares the complete contract and mutates returned nested fields to prove isolation.
- Model timeout and stream progress remain separate boundaries. A cache improvement does not prove model correctness, remove provider latency, or turn interrupted gameplay into successful acceptance.
