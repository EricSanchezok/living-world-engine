# Shared State Prefix Layout Experiment

Artifact-Version: 1
Status: Approved

## Intent

Under the authorized [non-thinking gameplay experiment](0029-nonthinking-gameplay-efficiency-experiment.md), test a lossless ordering of existing shared batch JSON members. A shrinking repair subset can change an early catalog audit hash before a large identical state payload, preventing provider prefix reuse.

## Contract

The opt-in `shared-state-first-v1` rendering policy changes only object-member order: outer `state` first, its `shared` member first, and the shared logical `state` followed by `referenceCatalog` before its remaining members. All other members retain canonical order. Keys, paths, values, arrays, catalogs, scope boundaries, repair feedback and complete per-slot hashes are preserved. The renderer checks parsed-content equality by canonical hash. It rejects an explicitly selected policy without its required shared envelope before model dispatch. Ordinary singleton requests retain their existing rendering; this experiment makes no claim of restoring cache reuse between a batch and a singleton.

The policy is part of the model request and rendering contract hash. It does not change generation settings, schema, action count, decoder behavior, validation, provider retry, recovery bounds, or selected references. Existing physical repair-tail rendering preserves the ordered initial prefix while retaining all feedback. Defaults and registered Compositions remain unchanged.

## Plan

Measure source-bound prefix opportunities offline and verify actual gateway request bodies, then freeze a prospective paired trial with code, inputs, ordering, model settings, cost limits and acceptance criteria. Prefix length alone is not a cache-hit or semantic-success result. Compare provider-reported hit/miss tokens, total tokens, HTTP calls, cost and completion separately. The encompassing experiment still owns source-semantic review and full-world acceptance.

## Verification

Parse reordered payloads and compare complete original contexts and expanded slot hashes. Retain array order, Unicode, false, zero, null and delimiter-containing text. Exercise composition with physical repair tails and actual HTTP serialization, preserve all non-context body fields, bind the policy in audit hashes, and reject unsupported envelopes without network use. Run relevant tests and `npm run check:fast` before committing.

## Evidence

[Decision 0123](../decisions/0123-order-shared-state-before-batch-metadata.md) owns alternatives and limits. The experiment record owns immutable source requests and prospective cache measurements.
