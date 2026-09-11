# Zero padding causes model repair

Artifact-Version: 1

## Executive summary

A complete-player trial generated existing decimal aliases without their leading zero. Exact wire validation rejected those fields and invoked model recovery despite an unambiguous ordinal match.

## Summary

The failed batch contained three shortened fact selectors across three slots. Exact canonical validation was correct to reject the malformed representation; the missing capability was a narrow lexical adapter before that validation. The trial later failed elsewhere and cannot establish the number of calls or elapsed time a future run will save.

## Timeline

- The root compilation directory assigned r048 and r086 to existing facts.
- Output used r48 and r86 in declared reference fields.
- The alias representation disabled the common output preprocessor and required at least three digits.
- The request was rejected before canonical decoding and entered model recovery.
- The source directory and raw output established an exact lexical recovery rule without inferring an action's meaning.

## Root cause

The encoding coupled ordinal identity to display padding, and provided no lossless lexical normalization before schema validation. Increasing model calls could fix formatting but was unnecessary for this specific mismatch.

## Guardrails

[The exact ordinal contract](../specs/0112-normalize-exact-compilation-alias-ordinals.md) confines normalization to schema-owned reference positions and the pinned dictionary. Raw output and per-field normalization evidence remain available. Unknown identifiers, conflicting operators and invalid type or slot membership remain failures. A recovered reference does not establish semantic or full-game correctness.
