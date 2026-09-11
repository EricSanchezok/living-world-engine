# Account-scoped HTTPS DNS

## Status

Accepted
Class: architecture

## Context and Problem Statement

A local synthetic DNS route can time out during a long model execution even when a direct connection to a current public DNS answer succeeds. Pinning a historical address outlives DNS TTLs, while changing the system VPN affects unrelated applications. Model accounts already own their network transport.

## Decision Drivers

- Preserve provider identity, TLS validation and model request bytes.
- Refresh addresses within DNS TTLs and coalesce concurrent resolution.
- Isolate the route choice to explicit local account configuration.
- Keep network reliability separate from algorithm efficacy and billing claims.

## Considered Options

1. Depend on the system synthetic DNS route.
2. Pin a manually resolved IP for the process lifetime.
3. Add an account-scoped HTTPS DNS JSON lookup with TTL caching.
4. Change system VPN or routing policy.

## Decision Outcome

Select the account-scoped lookup. The account supplies an HTTPS resolver URL, and its Undici Agent resolves IPv4 addresses without rewriting the original request hostname. Cache entries expire at the minimum TTL of the relevant answer and alias chain. Concurrent lookups share one request; failures are not cached or retried internally. Redirects and cross-origin provider calls fail. The resolver receives DNS names and no provider credentials or request bodies. The initial consumer is the full-step experiment's explicitly configured transport.

Opted-in accounts allow at most 60 seconds for the shared DNS request and 75 seconds for DNS plus connection setup. The original ten-second lookup window expired during a full local batch; a twenty-second event-loop stall reproduces the failure without a paid model request. These bounds allow that observed delay while preserving a finite failure deadline, unchanged model request deadlines and no internal retry. They do not eliminate synchronous local computation or guarantee acceptable gameplay latency; see the [incident and regression](../postmortems/0041-local-batch-stall-expired-dns.md).

An experiment may explicitly configure a resolver's HTTPS IP endpoint when the resolver hostname itself depends on the failing local DNS route. Its certificate must validate for that IP; no TLS checks are bypassed. This fixes the resolver service address, not the model provider address: provider answers still expire at their DNS TTL. A successful short route probe establishes reachability only, and does not prove that a later complete game trajectory will succeed.

## Pros and Cons of the Options

System DNS needs no configuration but retains the observed synthetic-route failure. Manual pinning is simple but silently uses expired routing information. HTTPS DNS keeps addresses fresh and the choice local, but depends on the resolver's availability and DNS JSON contract, and the current implementation supports IPv4 accounts only. System routing changes can solve the problem broadly but exceed the application's ownership scope.

## Links

- [Account network binding](0084-account-scoped-node-network-binding.md)
- [Model Gateway contract](../game-design/model-gateway.md)
- [Full-step experiment](../specs/0026-full-step-efficiency-experiment.md)
- [Cloudflare DNS JSON fields and TTL](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/)
- [Real account socket and DNS tests](../../src/engine/models/__tests__/model-dns.test.ts)
