# FullCatalog C3 stabilized behavior

Versioned artifacts begin with `v1/`, exported from recorded FullCatalog game executions. Schema-v2 successors combine that immutable base with manually selected relational gameplay captures that are independently regenerated through the real FullCatalog compiler.

The frozen dataset lives under
`benchmarks/action-compilation/fullcatalog-stabilized/v1/`. Its source capture,
state checkpoints and exploratory ranker artifacts live under the ignored
`.livingworld-benchmarks/` tree. Local Encoder weights and persistent candidate
vectors live under `.livingworld-cache/`. `benchmarks/registry.json`
is the authoritative index; do not append new cases to a frozen version.

Each accepted slot case references one deduplicated full C3 context using `contextHash` and `slotIndex`. `requiredCandidateKeys` contains the final resolved candidate keys, sorted and deduplicated. It is a behavioral reference to the stable production path, not a claim that the model's selection is semantically perfect.

Export a version with:

```sh
npm run benchmark:export:action-compilation-reference -- --database .livingworld-v23/livingworld.sqlite --execution <fullcatalog-execution-id> --version <version>
```

The direct export is read-only and performs no LLM call, but it rejects R5 executions. To grow the benchmark from an R5 instance, run:

```sh
npm run benchmark:refresh:action-compilation-reference -- \
  --database .livingworld-v23/livingworld.sqlite \
  --instance <instance-id> \
  --base benchmarks/action-compilation/fullcatalog-stabilized/v1 \
  --version 2
```

Refresh reads the Ledger without mutation, recreates each full context from its captured state and actions, calls FullCatalog through the normal gateway, verifies exact context equality, and publishes via staging plus atomic rename. Schema v2 records separate capture/reference Algorithm hashes and `base-v1`/`r5-captured` strata. Do not overwrite a published version.

Run the offline v3 graph/encoder comparison against this frozen version with:

```sh
npm run benchmark:compare:action-compilation-retrieval-v3 -- --dataset benchmarks/action-compilation/fullcatalog-stabilized/v1 --output benchmarks/action-compilation/fullcatalog-stabilized/evaluations/retrieval-graph-ab-v3 --model multilingual-e5-small
```

The comparison never calls an LLM or changes the world. Missing local encoder
assets are reported as `blocked`; no online download is attempted. A learned
ranker trained from the current 46 cases is exploratory only and cannot be
promoted without the independent-snapshot training gate.

For the encoder track, install the pinned Transformers.js-compatible ONNX
asset as described in the [benchmark maintenance guide](../../README.md). The
comparison records the local asset and library hashes, uses fixed `query:` /
`passage:` prefixes, and fails closed when the files are missing or corrupt.

The production-shaped v4 evaluation uses the same asynchronous runtime implementation, one joint physical-batch budget, and the persistent read-only cache:

```sh
npm run retrieval:cache:warm -- --dataset benchmarks/action-compilation/fullcatalog-stabilized/v1
npm run retrieval:cache:verify -- --dataset benchmarks/action-compilation/fullcatalog-stabilized/v1
npm run benchmark:compare:action-compilation-retrieval-v4 -- --force
```

Results live under `evaluations/retrieval-runtime-ab-v4/`. That historical artifact retained FullCatalog because its treatment missed the then-current gate. Decision 0100 later promoted the separately evaluated R5 relational implementation through an explicit product decision; the historical result is unchanged.
