# Shared planning catalog encoding

Artifact-Version: 1
Status: Approved

## Intent

Reduce repeated reference catalog records and ordering in the indexed planning pipeline while retaining complete logical contexts. This experiment follows the authorized full-step efficiency objective; offline representation savings do not certify model behavior or gameplay latency.

## Contract

An optional Composition setting applies the existing exact catalog-prefix and record-template codecs after physical batching and the indexed planning adapters. It targets plan commitment, plan verification and resolution continuation batches only. Every logical source hash, candidate field, slot-specific permission, ordering, repair issue and original action survives exact reconstruction. The model receives the complete decoding contract. Shared records alone never grant a slot access to another slot's references.

The adapter preserves the system prompt, output schema, existing preprocessing, inference parameters, original task and all non-state context fields. It appends only the catalog decoding instruction and binds its content hash in the request prompt identity and Composition. It introduces no output repair, model call, summary, retrieval narrowing, altered random commitment or action reduction. Unsupported roles pass through unchanged; a targeted batch with the wrong codec or malformed source binding fails before dispatch. Default Compositions remain unchanged.

## Plan

Reuse the existing reversible codecs through one provider adapter, register the optional indexed-pipeline configuration, and expose it in the existing experiment runner. Measure complete recorded requests including the decoding notice before performing a separately frozen live comparison.

## Verification

Exercise the actual Truth batch collector and HTTP adapter, exact source restoration, different candidate permissions and orders, scoped repairs, unchanged output validation and unselected defaults. Compare full-body token counts on recorded planning, verification and continuation inputs. Preserve failed and unknown live responses. Run relevant tests and check:fast before committing.

## Evidence

[The adapter](../../src/engine/mechanics/planning-catalog-encoding.ts) reuses [catalog prefixes](../../src/engine/mechanics/shared-catalog-prefix.ts) and [record templates](../../src/engine/mechanics/shared-catalog-records.ts). Its [tests](../../src/engine/mechanics/__tests__/planning-catalog-encoding.test.ts) cover the production request boundary. No model success or 60-second gameplay claim follows from a lossless round trip.
