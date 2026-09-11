# Turbopack Runtime-module Resolution

Artifact-Version: 1

## Executive summary

Creating a default relational-RRF instance returned HTTP 503 even though the pinned multilingual E5-base model and every initial Blackmarsh passage were present and valid. Next.js Turbopack replaced direct `require.resolve` calls in the Route Handler bundle with internal external-module identifiers, so the local encoder could not locate the installed Transformer and ONNX Runtime package directories used in its fingerprint. Runtime module resolution now invokes Node's resolver indirectly, requires an absolute filesystem path, and has a focused regression test.

## Summary

The local encoder verifies the model directory, Transformer library, and ONNX Runtime library before opening the passage cache. CLI cache verification exercised the unbundled TypeScript module and succeeded, while unit tests supplied fake encoders and the production build compiled the Route Handler without executing its preflight. A real new-instance request was therefore the first check to execute library fingerprinting through the Turbopack-generated server module.

## Timeline

1. Relational RRF became the default candidate-selection algorithm with explicit model installation and initial-passage warmup requirements.
2. The local workbench started successfully and its world and instance listing endpoints returned HTTP 200.
3. Creating a Blackmarsh instance spent approximately 5.6 seconds in retrieval preflight and returned HTTP 503 before an instance or execution was created.
4. Ledger diagnostics showed zero executions, model-registry diagnostics showed the required profiles available, and cache verification reported 1,775 hits with zero misses.
5. The unbundled preflight succeeded, while the emitted Turbopack chunk showed `require.resolve` results replaced by `[externals]/...` identifiers rather than absolute paths.
6. Runtime resolution moved behind an indirect Node resolver invocation and the Route Handler bundle retained that invocation unchanged.

## Root cause

`libraryMetadata` depended on direct `require.resolve` syntax to find package roots for content hashing. Turbopack statically interpreted those calls while compiling the application Route Handler and substituted its own module-graph identifiers. Those identifiers are valid inside the bundler but are not filesystem paths, so walking their parent directories could never reach `node_modules/@huggingface/transformers`. The model hash ran first, accounting for the visible delay before the fail-closed 503. The test gap existed because model and cache commands run outside Next.js, encoder unit tests replace the expensive native boundary, and a successful build does not execute model preflight.

## Guardrails

- [Local encoder runtime-resolution test](../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.test.ts) requires both native encoder dependencies to resolve to absolute installed-module paths through the shared runtime helper.
- [Runtime module resolver](../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder.ts) keeps Node resolution indirect and rejects non-absolute results before package traversal or fingerprinting.
- [Relational candidate-selection specification](../specs/0022-relational-candidate-selection-and-reference-refresh.md) keeps explicit model and passage preflight fail-closed, so a packaging failure cannot silently change algorithms or invoke FullCatalog.
