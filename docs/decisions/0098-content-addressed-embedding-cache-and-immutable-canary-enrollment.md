# Content-addressed embedding cache and immutable canary enrollment

## Status

Superseded by [0100](0100-promote-relational-rrf-and-refresh-reference-data.md)
Class: architecture

## Context and Problem Statement

Local multilingual-E5 evaluation spends minutes regenerating candidate vectors after each process restart even though most candidate passages repeat across contexts and world instances. The existing Candidate Retrieval middleware also exposes a canary helper without a production enrollment owner, while its benchmark-bound query preparation and per-slot budgets cannot safely represent a physical multi-slot model request.

## Decision Drivers

- Reuse expensive deterministic candidate embeddings without treating cache data as canonical state.
- Keep derived binaries out of immutable, potentially read-only world packages.
- Invalidate vectors exactly when model, tokenizer, runtime, text construction, or passage content changes.
- Keep experiment assignment stable for the lifetime of a persistent world instance.
- Pin every behavior-affecting variant through the existing algorithm manifest boundary.
- Prevent shortlist, symbol repair, or batch union behavior from bypassing the measured retrieval contract.

## Considered Options

- Recompute every catalog in memory after each process start.
- Store vectors inside each world package or primary world-state SQLite database.
- Persist content-addressed vectors in a separate local cache and assign concrete algorithm variants once at instance creation.
- Reassign a control or treatment variant for every invocation and allow FullCatalog fallback on treatment failure.

## Decision Outcome

Store candidate vectors in a separate local cache rooted at `LIVINGWORLD_CACHE_ROOT`, partitioned by world content hash and an encoder fingerprint, and keyed by the exact passage SHA-256. Store only verified vector bytes and metadata; candidate passage text remains reconstructible from the authoritative model context. Load the encoder once per process, persist candidate embeddings, and compute dynamic query embeddings at runtime with a bounded in-memory cache.

Represent a canary as an immutable experiment manifest whose variants contain concrete `AlgorithmRef` values. Assign one variant from a domain-separated 10,000-bucket hash when an eligible instance is created, persist that enrollment, and use the selected algorithm manifest for every execution and replay. One experiment may be active in the world-execution layer, and a new experiment version is required to change weights or behavior.

Persist a first-write-wins enrollment stop per experiment version in the local operational database. Cache integrity or runtime safety failure stops future instance assignment across process restarts without changing any existing enrollment or canonical world state.

Candidate Retrieval applies a joint physical-batch budget and a per-slot membership gate. Symbol repair may search only the slot shortlist, while the complete resolver remains authoritative after membership succeeds. Missing cache data or treatment dependencies fail before provider work and never select the control variant implicitly.

## Pros and Cons of the Options

### Recompute in memory

- Good: no persistent format or cleanup mechanism.
- Bad: repeats the dominant local cost after every command or server restart.

### Store beside the world or canonical state

- Good: cache ownership appears visually close to its source.
- Bad: pollutes versioned world content, complicates read-only packages, couples disposable data to authoritative persistence, and duplicates vectors across instances.

### Separate content-addressed cache and immutable enrollment

- Good: exact reuse and invalidation, recoverable corruption, stable cohorts, pinned replay behavior, and shared data across instances of one world version.
- Bad: requires an additional local cache lifecycle, readiness checks, and explicit rebuild tools.

### Per-invocation assignment with fallback

- Good: gathers traffic quickly and hides treatment availability failures.
- Bad: mixes algorithms inside one persistent trajectory, biases experiment results, obscures failures, and makes replay identity depend on operational state.

## Links

- [0097 — Action Compilation graph-aware candidate retrieval](0097-action-compilation-graph-retrieval.md)
- [0096 — Versioned behavioral benchmark datasets](0096-versioned-behavioral-benchmark-datasets.md)
- [0075 — Pin configured execution algorithms](0075-pin-configured-execution-algorithms.md)
- [Spec 0020 — Persistent encoder cache and instance canary enrollment](../specs/0020-persistent-encoder-cache-and-instance-canary.md)
- [0100 — Promote relational RRF and refresh reference data](0100-promote-relational-rrf-and-refresh-reference-data.md)
