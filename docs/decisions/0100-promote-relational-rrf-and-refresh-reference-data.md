# Promote relational RRF and refresh reference data

## Status

Accepted
Class: architecture

## Context and Problem Statement

The production default still supplies the complete Action Compilation candidate catalog. The graph-hybrid candidate and its first persistent-cache integration established fail-closed runtime boundaries, but their per-slot retrieval design is not the best measured treatment. R5.5 adds relational passages, multi-seed expansion, typed-channel reciprocal-rank fusion, and coverage-aware joint allocation. On the immutable 46-case FullCatalog benchmark it recovers 547 of 609 required keys at approximately 80.04% compression: micro recall `89.819%`, just below the historical `90%` activation threshold.

Production verification subsequently exposed a material evaluation-shape difference: the historical experiment pre-encoded queries across all 24 dataset contexts, while deployed execution encodes only one physical batch. The pinned E5 runtime is batch-shape-sensitive. The actual production path deterministically recovers 545/609 (`89.491%` micro, `90.712%` macro) at the same compression and P95 ratio. The immutable historical result remains evidence of that experiment; the production result is authoritative for deployed behavior.

The reference benchmark also has no complete repository-owned path from a relational gameplay execution to independently regenerated FullCatalog labels. Directly exporting the relational output would turn a treatment's shortlist into its own reference and invalidate the experiment.

## Decision Drivers

- Put the strongest measured deterministic retriever behind the production Role contract without duplicating benchmark and runtime logic.
- Preserve strict physical-batch budgeting, slot privacy, candidate materialization, semantic validation, transaction safety, and fail-closed behavior.
- Pin every behavioral choice at its natural recursive Algorithm node.
- Keep model assets and derived vectors explicit, local, verified, reusable, and unavailable to implicit network download.
- Preserve instance and replay identity across restart and default changes.
- Grow reference data from real gameplay only through independently regenerated FullCatalog outputs with exact provenance.
- State the accepted recall tradeoff truthfully instead of redefining or fabricating the historical gate.

## Considered Options

- Keep FullCatalog as the permanent default and continue R5.5 only as an offline experiment.
- Keep graph-hybrid-e5 in production and copy R5.5 into another independent runtime implementation.
- Promote R5.5 as one shared relational implementation, with FullCatalog retained only as an explicit reference Algorithm.
- Export relational gameplay results directly as new FullCatalog benchmark labels.
- Capture gameplay context and regenerate labels manually through the real FullCatalog compilation path.

## Decision Outcome

Promote the R5.5 behavior as `candidate-selection/relational-rrf@1` with `candidate-ranking/typed-channel-rrf@1` and `candidate-allocation/coverage-aware-joint-budget@1` children. The production verifier and future benchmark treatments execute the production physical-batch implementation. Remove `candidate-selection/graph-hybrid-e5@1` from the production registry after replacement; retain its immutable historical evidence. Keep `candidate-selection/full-catalog@1` as an explicit reference and relabeling Algorithm with no implicit fallback.

Make relational RRF the host default for newly created instances. This is an explicit product decision accepting the production result of 545/609 and `89.491%` micro recall, alongside the historical 547/609 experiment, even though the prior `90%` gate did not pass; activation metadata must not claim `hardGate: true`. Existing instances and replays remain bound to their persisted recursive Composition and are neither migrated nor hot-switched.

Resolve retrieval resources from any pinned candidate-selection `AlgorithmRef`, not from active-experiment state. Require explicit installation of the pinned Xenova multilingual-E5-base revision and explicit warming of initial world passages. Batch every physical request's deduplicated query misses into one encoder call, reuse verified passage vectors, and allow only post-creation dynamic passage misses to be encoded locally on demand. Asset, cache, or retrieval failure occurs before provider work and never downloads, falls back, or mutates canonical state. Record observed timing and cache evidence without imposing an arbitrary numeric latency gate.

Adopt manual reference refresh. Dedicated Ledger capture stores the complete pre-shortlist input and exact provenance. The direct exporter rejects any non-FullCatalog source. A repository-owned regenerator calls the normal gateway and `compileActions` without retrieval, verifies the recreated full-context hash, runs existing output/materialization/semantic validation, and publishes only validated labels. Dataset v2 is an immutable, provenance-partitioned superset of v1, deduplicated by `contextHash + slotIndex`, with conflict and compatibility failures before atomic publication. Gameplay capture itself performs no model call and never publishes a benchmark.

This decision supersedes the default-activation policy in [0097](0097-action-compilation-graph-retrieval.md) and the cold-cache runtime-miss policy in [0098](0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md). It retains their cache partitioning, exact integrity checks, immutable instance enrollment, physical-batch membership, and fail-closed/no-fallback constraints.

## Pros and Cons of the Options

### Keep FullCatalog as default

- Good: preserves maximal candidate recall.
- Bad: leaves the scalable production path unused despite a quantified and explicitly accepted tradeoff.

### Duplicate R5.5 into production

- Good: minimizes movement in the benchmark package.
- Bad: guarantees two behavior implementations and makes future parity a convention rather than a property.

### Shared relational implementation (selected)

- Good: one versioned production behavior, recursive ownership, a production-path offline verifier, lower context, and one optimization surface.
- Bad: deliberately accepts 64 missed production-baseline required keys and requires local model preparation before new-instance creation.

### Direct relational export

- Good: cheap and operationally simple.
- Bad: circular labels make recall meaningless and can institutionalize treatment omissions.

### FullCatalog regeneration (selected)

- Good: independent labels, exact lineage, real validation, immutable publication, and no runtime-side model cost.
- Bad: refresh is a deliberate operator action with additional FullCatalog model calls, and stochastic conflicts must be rejected rather than hidden.

## Links

- [Spec 0022 — Relational candidate selection and reference refresh](../specs/0022-relational-candidate-selection-and-reference-refresh.md)
- [R5 evaluation evidence](../../benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-r5/results.json)
- [R5 production verification](../../benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-r5/production-verification.json)
- [0099 — Typed hierarchical algorithm composition](0099-typed-hierarchical-algorithm-composition.md)
- [0097 — Action Compilation graph-aware candidate retrieval](0097-action-compilation-graph-retrieval.md)
- [0098 — Content-addressed embedding cache and immutable canary enrollment](0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md)
