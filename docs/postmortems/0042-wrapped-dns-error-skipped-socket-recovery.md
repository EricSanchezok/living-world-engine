# Wrapped DNS Errors Skipped Socket Recovery

Artifact-Version: 1

## Executive summary

A complete-world trial selected two attempts to establish a connection before HTTP socket handoff. Four compilation requests still stopped after one attempt because a DNS fetch wrapped its transient connection reset in `TypeError.cause`, while the connector inspected only the outer error code.

## Summary

STEP-E1 trajectory 06 completed initialization and then failed before any compiler response. Its step and revision remained zero. The experiment record owns the request identities, costs and prospective follow-up. All four unknown requests retain their full budget reservations; connection diagnostics do not establish provider billing.

## Timeline

- Six initialization requests completed successfully.
- Four compilation dispatches failed together with a DNS fetch error whose nested cause was `ECONNRESET` before TLS establishment.
- Connection evidence recorded four failed first attempts and no second attempts, despite the account selecting two.
- A regression through the real account DNS resolver, connector and local HTTP server reproduced the nested error and verified one eventual POST after connection recovery.
- A subsequent trial exposed the DNS fetch's `UND_ERR_SOCKET` variant. Its nested code was correctly recorded but excluded from the initial allowlist. A second fixture reproduces this ordinary DNS socket closure through the same pre-handoff path; response loss after provider handoff remains excluded.

## Root cause

The connector classified only `error.code`. Node fetch exposes a transport failure as `TypeError("fetch failed")` with the underlying coded error in `cause`. The existing direct connector injection tests supplied errors carrying a top-level code; DNS tests covered failures separately but did not exercise a wrapped DNS failure through the opt-in recovery path. This integration gap allowed the configured recovery to be silently skipped and omitted the useful nested error code from connection evidence.

## Guardrails

- The [account DNS integration test](../../src/engine/models/__tests__/model-dns.test.ts) fails the first DNS fetch with a wrapped reset or socket closure, then traverses the real connector and local socket. It verifies two DNS lookups, the recorded cause, and exactly one unchanged HTTP body received by the server.
- The [connector](../../src/engine/models/model-connector.ts) inspects a bounded, acyclic Error cause chain and requires every present code to be allowlisted. Unknown codes, malformed causes and certificate errors do not qualify.
- [Connector regressions](../../src/engine/models/__tests__/model-connector.test.ts) retain coverage for default single attempts, exhausted recovery, certificate failures, existing sockets and response loss after the server receives the body. [Decision 0111](../decisions/0111-bounded-socket-establishment.md) owns the pre-handoff boundary; no HTTP retry is introduced.
