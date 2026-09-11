# Repeated Normalized Context Processing

Artifact-Version: 1

## Executive summary

Continuous deterministic steps exposed growing local request-construction cost. The model gateway normalized complete context, then recursively sorted and copied that same normalized value again for two hash emissions and audit measurements.

## Summary

The generic hash and measurement helpers correctly normalize arbitrary inputs. Calling them independently on an already normalized request snapshot repeated work proportional to the complete context size. This expense persisted with zero external model calls or repair failures.

## Timeline

- A 48-Agent, three-step deterministic run showed increasing local time and serialized input bytes.
- Call-stack instrumentation attributed substantial request construction work to recursive canonicalization, sorting and JSON serialization.
- Source inspection found two repeated context-hash normalizations and one audit normalization after the gateway had already normalized the context.
- A request-owned preparation helper now supplies the detached normalized value, one context hash and measurements directly from that value.

## Root cause

Arbitrary-input utility boundaries were reused inside a pipeline that already owned normalized data. Their defensive normalization was repeated rather than shared within that request. The cost scaled with retained history even when request content, model behavior and repair count were unchanged.

## Guardrails

Each gateway invocation prepares a fresh detached context; no cache is keyed by a mutable caller object or shared across requests. Consumers must not mutate the prepared value. The generic hash and measurement functions retain their existing behavior. String hashing, Unicode byte sizes, numeric object keys, nulls, arrays, section sizes and state counts remain compatible.

[Measurement regressions](../../src/engine/runtime/__tests__/observability.test.ts) compare prepared and generic results and verify isolation from caller mutation. [Gateway tests](../../src/engine/models/__tests__/model-provider.test.ts) verify the actual transport boundary, ordered layout and unchanged context hash. Deterministic before/after evidence compares complete serialized-request witnesses and committed semantic hashes.

Request layout serialization and final request-document hashing retain their existing algorithms. This change saves local computation without removing context, altering model parameters or reducing model calls. Offline timing is not evidence of remote-model latency, token savings or semantic correctness.
