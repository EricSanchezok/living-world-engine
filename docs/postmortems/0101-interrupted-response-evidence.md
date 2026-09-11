# Interrupted response evidence

Artifact-Version: 1

## Executive summary

A gameplay planning request lost its socket while reading the response. The budget retained the full unresolved reservation, but the experiment evidence could not distinguish a response interrupted after headers from a request that never received headers. Incremental byte capture preserves that distinction without changing request behavior or accepting partial output.

## Summary

The failed trajectory committed no step. Its Ledger recorded a TypeError caused by UND_ERR_SOCKET with the message “other side closed”, approximately ninety-eight seconds after transport started. The model profile allowed three hundred seconds. This establishes a peer closure during response consumption; it does not establish whether the provider, intermediary, or network route caused that closure, what partial content arrived, or whether the request was charged.

## Timeline

- One planning component passed review while the larger component remained in flight.
- Response consumption threw and the trajectory stopped without committing.
- Ledger inspection identified the nested socket error and ruled out the configured request timeout as the observed error.
- A local HTTP peer reproduced a body interruption after delivering headers and partial UTF-8 bytes.

## Root cause

The experiment transport awaited the entire cloned response as text before writing any response evidence. A read failure discarded all received body bytes and response status from its evidence directory. Budget accounting correctly treated the request as unresolved, but the evidence gap obscured the transport boundary and encouraged an incorrect timeout diagnosis.

## Guardrails

The [experiment transport](../../src/engine/benchmarks/action-compilation/experiment-transport.ts) persists receipt metadata as soon as headers arrive and retains exact received bytes on body failure. Partial content is marked incomplete, never parsed as a successful model response, and never used to settle usage. The full reservation remains unresolved and subsequent dispatch stops.

The [transport regressions](../../src/engine/benchmarks/action-compilation/experiment-transport.test.ts) use a real local HTTP socket closure, including an incomplete UTF-8 character. They distinguish pre-header failure, verify unchanged successful response bytes, and assert retained budget exposure with no retry. These guardrails improve diagnosis; they do not claim to prevent external socket closure or prove playable gameplay.
