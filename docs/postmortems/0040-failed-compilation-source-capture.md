# Failed Compilation Sources Missing from Experiment Capture

Artifact-Version: 1

## Executive summary

Action Compilation emitted its benchmark source snapshot only after the model output passed gateway parsing and schema validation. A full-world step with four root batches therefore supplied only three standard captures. Selecting experiments solely from those captures could omit the structurally failing batch. The STEP-E1 comparison reconstructed and hash-verified that fourth source before freezing its samples; it did not exclude it.

## Summary

The missing capture belonged to execution `4bb7be12-0720-4158-b401-13e9616ef056` in `trajectory-e1-01`. Request, state and reference-audit evidence remained in the Ledger, but recovering the source required extra reconstruction and verification. The experiment report owns the source hashes, completed comparisons and their limitations. This defect concerns evidence completeness; fixing it does not improve model success rates.

## Timeline

- The full-world run submitted four root compilation batches with twelve actions each.
- A later paired experiment found only three standard source snapshots.
- The fourth source was reconstructed from the same state and audited action identities, then matched against the original serialized model context.
- The compiler capture path was extended to audited output failures, preserving each attempt's original input and repair identity.

## Root cause

Source capture depended on a successful `generateStructured` return because it used the returned model audit. The error path also carried that audit in `ModelOutputError`, but never emitted the input snapshot before localizing or propagating the failure. Existing tests asserted capture for valid outputs and checked failed-call accounting separately; they did not assert that a rejected gateway response remained discoverable through the production source reader.

## Guardrails

- The [compiler](../../src/engine/algorithms/eager-reference/action-compiler.ts) emits the same source payload once per attempt for successful responses and audited output failures. It does not invent model bindings for unaudited failures or alter model requests, recovery limits or output rejection.
- The [real gateway/compiler regression](../../src/engine/benchmarks/action-compilation/first-pass-runner.test.ts) injects malformed JSON and schema-invalid output at HTTP, exercises the actual repair, and verifies rejection, unchanged state, exact input hashes, audit binding, one capture per attempt and discovery of the failed root through the standard source reader.
