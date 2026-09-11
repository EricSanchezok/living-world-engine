# Isolate terminal root closer recovery

## Status
Accepted
Class: feature

## Context and Problem Statement

A complete JSON root followed by one redundant closer is rejected by the existing continuation guard. The internal unmatched-closer policy deliberately excludes this shape. Recovering it requires a new acceptance boundary rather than changing that policy's meaning.

## Decision Drivers

- Preserve every data character and the entire strict root.
- Keep parser identity, raw response and precise interpretation auditable.
- Avoid a model round trip for a bounded punctuation interpretation without weakening semantic validators.

## Considered Options

- Retain rejection and require model repair.
- Broaden the existing internal-closer policy to arbitrary root suffixes.
- Introduce a distinct opt-in candidate for exactly one matching terminal root closer.

## Decision Outcome

Select the isolated candidate defined in [0129](../specs/0129-terminal-root-closer-recovery.md). It runs after strict parsing and before the continuation guard. Default parsing and the internal-closer policy retain their behavior. The complete candidate must pass strict JSON parsing and decoded duplicate-key rejection before normal schema and semantic validation. No production algorithm selects it implicitly.

This is a declared interpretation of malformed syntax, not evidence of intended meaning or a general correction algorithm. Historical rejections remain rejections; counterfactual execution and prospective success have separate evidence.

## Pros and Cons of the Options

### Retain rejection

- Preserves the current boundary with no additional grammar interpretation.
- Requires regeneration even when one bounded deletion produces a complete strict root with unchanged data.

### Broaden the existing policy

- Exposes fewer policy names.
- Changes a pinned contract and can conflate dangling fields or multiple roots with harmless punctuation.

### Isolated terminal candidate

- Preserves data and physical request identity, exposes exact edits and requires no network call.
- Introduces one explicit interpretation and leaves other malformed or semantically invalid responses unresolved.

## Links

- [Terminal recovery contract](../specs/0129-terminal-root-closer-recovery.md)
- [Internal unmatched-closer decision](0122-limit-unmatched-closer-recovery.md)
- [Provider JSON parser](../../src/engine/models/model-adapter.ts)
