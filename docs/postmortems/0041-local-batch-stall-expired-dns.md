# Local Batch Work Expired a Shared DNS Lookup

Artifact-Version: 1

## Executive summary

A complete-world gameplay diagnostic finished Agent initialization, then lost all four compilation requests before receiving a response. Their common cause was the account's ten-second HTTPS DNS timeout. Short unauthenticated preflight calls had succeeded, but did not exercise network callbacks delayed by synchronous local batch work.

## Summary

STEP-E1 trajectory 03 remains a failed, uncommitted step. The experiment record owns request hashes, exact costs and prospective follow-up protocols. The four requests retain unknown billing reservations: the connection evidence is not a provider billing receipt. No conclusion about the low-thinking compiler's success or semantics follows from this failure.

## Timeline

- Initialization completed for all 48 Agents using seven successful HTTP responses.
- Local candidate work preceded the first compilation send by roughly 199 seconds. A process sample showed native ONNX inference running.
- Four compilation dispatches were recorded roughly 6.6 seconds apart. All failed together after approximately 20 seconds, with the root cause at the DNS fetch's abort signal.
- Four unauthenticated HEAD requests with a deliberate twenty-second event-loop stall reproduced the old shared-lookup timeout without paid model work.
- The opted-in account's lookup and connection windows were bounded at 60 and 75 seconds respectively, with unchanged request bodies, model deadlines, DNS TTLs and no retries.
- A subsequent trajectory still failed at the resolver's own TLS connection with `ECONNRESET`. Its hostname also resolved through the local synthetic DNS route. An isolated catalog can select a verified HTTPS IP endpoint to remove that dependency; the successful free route probe alone is not a complete-game acceptance result.

## Root cause

The shared DNS lookup used a ten-second abort signal. Callback processing in the same Node process competes with synchronous local computation and evidence persistence. A resolver response cannot be processed while that event loop is blocked; the shared pending lookup propagates its failure to every waiting connection. The observed lookup timeout is established by the Ledger error cause and the no-cost stress reproduction. The precise division of the real local delay between encoding, serialization and persistence remains unmeasured.

Existing DNS tests covered TTL refresh, coalescing, malformed responses and successful local sockets. The operational preflight covered a healthy short connection. Neither covered a callback delay beyond the old deadline. Merely preserving a long model-generation timeout did not protect the shorter DNS and connector windows.

## Guardrails

- The [DNS regression](../../src/engine/models/__tests__/model-dns.test.ts) exercises four coalesced lookups with a response after twenty seconds and verifies that a permanently unavailable resolver still terminates at sixty seconds without retries.
- The [account transport](../../src/engine/models/model-network.ts) gives DNS plus connection setup a bounded seventy-five-second window only for explicitly configured HTTPS DNS accounts. Origin restrictions, TLS hostname verification and request bytes remain unchanged.
- [Decision 0107](../decisions/0107-account-scoped-https-dns.md) records the reliability/timeout tradeoff. This mitigation does not remove local blocking or establish fluid gameplay; subsequent complete-world evidence must measure both.
