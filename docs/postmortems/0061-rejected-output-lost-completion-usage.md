# Rejected model output lost known completion usage

Artifact-Version: 1

## Executive summary

A completed model response could lose its usage and provider request identity in the runtime audit when JSON parsing, schema validation or codec decoding rejected its content. Transport success and output acceptance were conflated at the adapter return boundary. Completion metadata must survive output rejection independently of whether a canonical value exists.

## Summary

The issue affects runtime cost attribution and failure evidence, not whether invalid output is accepted. A deterministic gateway reproduction returned 11 input tokens, 7 output tokens, a stop reason and a provider response ID, but the rejected invocation recorded null for all four fields. The experiment's independent raw HTTP ledger retained provider usage and remained the budget authority; this finding does not justify changing historical charges or claiming new savings.

## Timeline

During the 2026-09-08 non-thinking gameplay investigation, real materializer failures motivated a dependent-field codec. Testing rejection of contradictory fields revealed that the gateway preserved an output error but lacked its known completion metadata. A failing gateway regression established the loss using an actual adapter and a mocked HTTP response. Additional cases covered empty, malformed and truncated content, canonical schema rejection and provider responses without usage.

## Root cause

The adapter constructed its successful return value after parsing and validation. The gateway obtained token usage, finish reason and response ID only from that return value. A later local validation exception therefore looked like a response without completion metadata, even though HTTP and provider generation had finished. Existing tests asserted the rejection or repair path without checking the completed response's usage and identity. Successful-response accounting tests did not exercise the boundary where content fails after billing evidence becomes available.

## Guardrails

[ModelOutputError](../../src/engine/models/model-provider.ts) carries optional completed-response metadata. The [adapter](../../src/engine/models/model-adapter.ts) attaches it when local output validation rejects an already completed result, and the [gateway](../../src/engine/models/model-gateway.ts) uses it in rejected invocation audits. Raw invalid output and validation paths remain available, while genuinely absent usage remains null and output rejection does not trigger a transport retry.

The [gateway regression tests](../../src/engine/models/__tests__/model-provider.test.ts) assert known token counts, response identity, finish reason, raw output and exactly one HTTP dispatch across codec, schema, empty, malformed and truncated outputs. A no-usage response explicitly remains unknown. The independent experiment HTTP ledger and raw response evidence remain the authority for historical cost reconciliation; this repair changes future runtime observation rather than rewriting prior records.
