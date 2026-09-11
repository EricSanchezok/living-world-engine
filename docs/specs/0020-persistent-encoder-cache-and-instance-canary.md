# Persistent encoder cache and instance canary enrollment

Artifact-Version: 1
Status: Superseded by [Spec 0022](0022-relational-candidate-selection-and-reference-refresh.md)

## Intent

Persist Action Compilation candidate embeddings across process restarts and world instances without writing derived data into a world package, and provide a reusable instance-level experiment boundary for future world-execution Algorithms. The default `candidate-selection/full-catalog@1` Algorithm does not load the retrieval runtime; a graph treatment cannot be activated until its immutable evaluation evidence passes the declared gates.

## Contract

Local encoder assets and derived vectors live under `LIVINGWORLD_CACHE_ROOT`, which defaults to `.livingworld-cache/`. Embedding stores are partitioned by immutable world content hash and encoder fingerprint; vectors are addressed by the SHA-256 of the exact passage text, stored as checksummed little-endian Float32 data, and never contain passage text, credentials, headers, or canonical state. Model loading and query encoding are single-flight, candidate vectors survive restarts, and a treatment runtime fails before provider work when its exact candidate passages are not already cached.

Action Compilation retrieval consumes the current full context rather than a benchmark dataset. It applies one strict budget to the physical batch, exposes only the joint shortlist to the model, restricts symbol repair to the current slot shortlist, and rejects a valid key that is outside that slot before authoritative FullCatalog materialization. The existing resolver, semantic validation, transaction, and commit boundaries remain authoritative, and no FullCatalog retry is introduced.

World-execution experiments use immutable manifests and deterministic 10,000-bucket instance assignment. An instance persists its enrollment and complete recursive variant Composition; it never changes variants between invocations or restarts. One active experiment is allowed in the world-execution layer, explicit algorithm tuning is excluded, unavailable manifests fail closed, and ordinary public world DTOs do not expose experiment or model configuration. Graph candidate selection has no active treatment while its offline evidence remains below the recall and physical-batch compression gates.

The engine persists assignment, cache, shortlist, membership-rejection, repair, provider, and terminal outcome evidence in the Ledger. Trusted local inspection and read-only reports may expose that evidence. Any accepted invalid, private, or out-of-shortlist reference, cache integrity failure, manifest drift, or replay/state mismatch halts new enrollment without changing existing instance variants.

## Plan

Move the production retriever and local encoder ownership into eager-reference, add a separate content-addressed SQLite cache and operational cache commands, extend eager-reference configuration with a pinned retrieval policy, add an experiment registry plus world-instance enrollment, and adapt the frozen benchmark reader to the same runtime implementation without changing dataset v1. Add a physical-batch v4 evaluation layer and stable Ledger evidence before any treatment can be registered active.

## Verification

Prove cross-process cache reuse, exact invalidation, concurrent single-flight behavior, cold-cache provider isolation, dynamic query scoring, physical-batch budget enforcement, per-slot membership, immutable experiment assignment, restart recovery, manifest validation, no fallback, and control-path non-use of the encoder. Run the v4 FullCatalog control, cache warm/verify commands, focused runtime/server/benchmark tests, `npm run check:fast`, and the repository governance gates.

## Evidence

- [Persistent embedding cache](../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache.ts)
- [Physical-batch retrieval runtime](../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime.ts)
- [Experiment registry](../../src/engine/runtime/experiments.ts)
- [Server treatment preflight](../../src/server/action-compilation-retrieval-runtime.ts)
- [Activation evidence verifier](../../src/server/experiment-activation.ts)
- [v4 offline evaluation](../../benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-runtime-ab-v4/README.md)
- [Decision 0098 — Content-addressed embedding cache and immutable canary enrollment](../decisions/0098-content-addressed-embedding-cache-and-immutable-canary-enrollment.md)
- [Spec 0022 — Relational candidate selection and reference refresh](0022-relational-candidate-selection-and-reference-refresh.md)
