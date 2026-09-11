# Dangling JSON Field Salvage

Artifact-Version: 1

## Executive summary

A transition response closed its outer object too early, then continued with fields containing empty arrays. The parser treated the last field array as an independent corrected answer. Validation rejected that array, and repair received an empty candidate instead of the original action-bearing text.

## Summary

The malformed response remained available in the raw HTTP Ledger artifact, so the failure could be traced without another model request. The bug did not commit an invalid world: schema validation rejected the salvaged array. It did make the rejection misleading and erased useful candidate evidence at the repair boundary.

## Timeline

- A live full-world transition generated a complete outcomes object followed by dangling top-level fields.
- The top-level correction scanner skipped commas and property names while searching for another JSON opener.
- It selected the final empty field array; the repair candidate became that array.
- Source inspection reproduced the selection from the recorded HTTP response.
- The parser gained an explicit rejection for a field or closing delimiter continuing after a complete root.

## Root cause

The parser protected descendants inside an unbalanced root, but assumed everything between balanced roots was explanatory prose. An extra closer made a partial object appear balanced, allowing field values in the remainder to masquerade as later corrections. Tests covered malformed nested batches and genuine prose-separated corrections, but not premature root closure followed by additional fields.

## Guardrails

[Gateway and parser tests](../../src/engine/models/__tests__/model-provider.test.ts) reject dangling fields and extra root closers while preserving genuine complete corrections. The gateway retains the full original text and known usage for bounded repair; it does not remove a syntactically matched closer or synthesize missing fields. The [transition candidate tests](../../src/engine/mechanics/__tests__/transition-candidate-repair.test.ts) preserve the latest rejected value and its source binding. Local parsing correctness is distinct from a measured model recovery or gameplay improvement.
