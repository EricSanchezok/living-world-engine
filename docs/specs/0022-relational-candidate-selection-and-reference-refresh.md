# Relational candidate selection and reference refresh

Artifact-Version: 1
Status: Implemented

## Intent

Promote the R5.5 experiment into one production Action Compilation candidate-selection implementation, make that implementation the default for newly created world instances, and provide a manual, provenance-safe path for growing the frozen FullCatalog reference benchmark from real gameplay captures.

This change deliberately accepts the historical R5.5 result of 547/609 required keys and its production physical-batch verification of 545/609: production micro recall `0.8949096880`, macro recall `0.9071189879`, average compression `0.8003537995`, and P95 shortlist ratio below `0.20`. Neither result is described as passing the historical 90% micro-recall gate. Existing instances retain their persisted Composition. Gameplay never expands a benchmark automatically, and the runtime never falls back implicitly to FullCatalog.

## Contract

### Production Composition

The default Composition contains this recursive subtree:

- `candidate-selection/relational-rrf@1`
  - `candidate-ranking/typed-channel-rrf@1`
  - `candidate-allocation/coverage-aware-joint-budget@1`

The parent pins a `0.20` physical-batch shortlist ratio. The ranking child pins multilingual E5-base fingerprint `sha256:25c0f4bc4ddc81782c76a7be891f4b71d81b9d277267fc801e2f4cd10779a543`, graph depth `3`, pseudo-seed count `16`, and the identity, state, fact, and temporal channels. The allocation child pins compact-kind ratio `0.15`. Passage and query schemas, RRF constants, channel weights, and tie-breaking are implementation-version behavior. Every operator-adjustable behavior parameter is explicit in the responsible recursive `AlgorithmRef`.

The production verifier and future R5.5 treatments call the production physical-batch implementation. The immutable historical artifact remains at 547/609 because it pre-encoded queries across the entire dataset; the pinned E5 runtime produces batch-shape-sensitive embeddings, so that artifact is not presented as exact production parity. The production verifier records the 545/609 deployed baseline and guards it against drift. The superseded production `candidate-selection/graph-hybrid-e5@1` is removed from the runtime registry while its historical benchmark evidence remains immutable. `candidate-selection/full-catalog@1` remains the reference and relabeling Algorithm, but is not a runtime fallback.

One physical Action Compilation batch constructs the catalog, relational index, and passages once. It deduplicates at most sixty slot-channel queries and sends all cache misses through one encoder batch. A bounded process-local cache supports batch hits, partial misses, and concurrent single-flight work. Full hits do not invoke the encoder; partial hits encode only misses. Retrieval failures occur before provider invocation and canonical mutation.

The initial world passages must be prepared explicitly before an instance using relational retrieval can be created. Runtime loading verifies the pinned local model revision, ONNX digest, directory digest, and encoder fingerprint without network access. Initial cold or corrupt passage caches fail creation with an actionable error. Passages introduced by later state changes may be encoded and persisted on demand with the already verified local model; failure still occurs before provider invocation. Runtime services resolve resources for any persisted candidate-selection `AlgorithmRef`, including restart and replay.

Stable retrieval evidence includes passage encoding time, query batch size, query cache hits and misses, query encoding time, passage cache hits and misses, selected and visible counts, shortlist ratio, and a typed failure category. No subjective numeric latency gate is imposed; measured results are recorded after implementation.

The supported preparation commands are:

```sh
npm run retrieval:model:install -- --model multilingual-e5-base
npm run retrieval:cache:warm -- --world blackmarsh --model multilingual-e5-base
```

### Manual reference refresh

Only `model.action_compilation.context.captured` Ledger events are valid gameplay sources. Capture schema v2 stores the complete pre-shortlist context and its hash, exact state, complete `AgentActionProposal[]`, model profile/model/prompt/key/projector/repair-policy versions, capture Composition and manifest hash, execution identity, and source ordering. Captures and the game database remain read-only inputs.

A direct reference exporter accepts only executions whose pinned candidate-selection node is `candidate-selection/full-catalog@1`. It rejects relational executions and directs the operator to capture and regenerate. The built-in regenerator uses the normal `ModelGateway`, original profile/model/prompt, captured state, captured actions, and real `compileActions` FullCatalog path. It injects no retrieval runtime, verifies the regenerated full-context hash byte-for-byte, and retains only slots that pass the existing response schema, candidate materialization, and semantic validation. Model calls occur only during the explicit refresh command.

The canonical entrypoint is:

```sh
npm run benchmark:refresh:action-compilation-reference -- \
  --database .livingworld-v23/livingworld.sqlite \
  --instance <instance-id> \
  --base benchmarks/action-compilation/fullcatalog-stabilized/v1 \
  --version 2
```

Repeated `--execution` filters and an official `sources-000.jsonl.gz` input are also supported. Generic save JSON without provenance is rejected.

Dataset schema v2 separates capture and reference Algorithm manifest hashes, records base-dataset lineage and multiple execution/initial-state source groups, and marks cases as `base-v1` or `r5-captured`. The merge key is `contextHash + slotIndex`: identical FullCatalog labels deduplicate and differing labels abort publication. Sources must agree on world, model, prompt, projector, candidate-key, and repair-policy fingerprints. Publication verifies all hashes in a staging directory and uses an atomic rename; v1 is never rewritten. Evaluation reports base-v1, r5-captured, and combined metrics separately.

## Plan

The recursive Roles, shared relational implementation, generalized resource resolution, explicit model preparation, default switch, capture/regeneration/schema-v2 publication, production verifier, and current-state documentation are implemented. The verifier's discovery that dataset-global query pre-encoding does not reproduce physical-batch embeddings is retained as evidence rather than hidden by changing a threshold or tuning against the benchmark.

## Verification

Prove the production physical-batch v1 baseline at 545/609 with the recorded micro, macro, compression, P95, and determinism values, and preserve the immutable 547/609 historical artifact with an explicit batch-shape explanation. Prove one encoder call for all misses, none for full hits, partial-miss batching, and concurrent query single-flight. Cover mandatory anchors, per-slot privacy, one 20% physical-batch budget, out-of-shortlist rejection, corrupt caches, missing assets, zero provider work on retrieval failure, dynamic passage writes without network, immutable instance/replay pinning, and the new-instance default.

For refresh, prove relational direct-export rejection, complete v2 capture, normal-gateway FullCatalog regeneration, exact context matching, real validation, `46 + N` merge behavior, identical-label deduplication, conflicting-label rejection, incompatible-provenance rejection, v1 readability, failed-publication cleanup, and stratified reports. Run focused tests, `npm run check:fast`, algorithm catalog validation, benchmark verification, Blackmarsh validation, production build, governance gates, and local startup acceptance.

## Evidence

- [Production R5.5 verification](../../benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-r5/production-verification.json) records 545/609 recall, deterministic 80.04% compression, cache/timing measurements, no latency gate, and the immutable historical comparison.
- [Historical R5 evidence](../../benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-r5/results.json) retains the original dataset-global 547/609 result.
- [Algorithm catalog](../game-design/algorithm-catalog.md) records the recursive production Composition and benchmark-only diagnostics separately.
- `npm run benchmark:verify:relational-rrf`, focused runtime/refresh tests, `npm run check:fast`, algorithm validation, world validation, production build, governance gates, and local startup acceptance form the implementation verification set.
