# Relational RRF evaluation

`results.json` is the immutable R5 experiment artifact. Its R5.5 treatment pre-encoded every query from all 24 dataset contexts together and reported 547/609 recall.

`production-verification.json` runs `candidate-selection/relational-rrf@1` through the deployed physical-batch boundary. The pinned E5 runtime is batch-shape-sensitive, so this path reports 545/609 and is authoritative for production behavior. Both results remain below the historical 90% micro-recall gate; Decision 0100 explicitly promotes the production result without claiming `hardGate: true`.

Reproduce the production artifact after installing the pinned model and warming the v1 dataset passages:

```sh
npm run retrieval:model:install -- --model multilingual-e5-base
npm run retrieval:cache:warm -- \
  --dataset benchmarks/action-compilation/fullcatalog-stabilized/v1 \
  --model multilingual-e5-base
npm run benchmark:verify:relational-rrf -- --force
```

The verifier is offline and read-only with respect to frozen benchmark inputs and world data: it makes no model-provider request, network request, or world mutation. Without `--force` it reports a fresh measurement without changing the checked-in artifact. `--force` replaces only this derived verification artifact; it never rewrites the frozen v1 dataset or historical `results.json`.
