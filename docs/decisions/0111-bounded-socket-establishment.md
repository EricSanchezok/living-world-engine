# Bounded Socket Establishment Before HTTP Dispatch

## Status

Accepted
Class: architecture

## Context and Problem Statement

A full-world step can compile every action and still fail when a later provider TCP connection times out. Repeating an HTTP request after losing its response can repeat charged model work. Treating every failed socket establishment as a terminal model failure also prevents continuous gameplay on a transiently failing route.

## Decision Drivers

- Preserve exactly one HTTP request and one model sampling opportunity per invocation.
- Distinguish connection attempts from HTTP requests and billable model usage.
- Keep TLS verification, cancellation, finite deadlines and unknown-billing reservations.
- Make the recovery choice explicit in a frozen full-world experiment.

## Considered Options

1. Stop after every socket establishment failure.
2. Enable SDK retries for model HTTP errors.
3. Allow one additional socket establishment attempt before handing a connection to the HTTP client.
4. Repeat the entire failed game step automatically.

## Decision Outcome

Select explicit bounded connector recovery for the full-step experiment. The connector may attempt TCP/TLS establishment twice for allowlisted transient errors while it has not yielded a socket to Undici. Certificate failures and existing upgraded sockets are excluded. Once the socket is handed off, any later error propagates without repeating the request. General account transports retain one connection attempt unless their catalog explicitly sets `network.socket_connect_attempts` to two. Both the workbench and experiment runner consume that same account setting.

The trajectory runner keeps its SDK HTTP transport limit at one, preserves complete request bodies and records timestamped connection attempts, results and error codes separately. An ultimately failed fetch keeps its conservative unknown-billing reservation. Historical missing responses are not retrospectively reclassified as free. Each attempt keeps the account's connection deadline; the model request deadline can terminate the encompassing operation sooner.

The allowlist includes a DNS fetch's wrapped socket-close error. The DNS service may have received its name lookup, but the model HTTP client still has no provider socket. This permits recovery of that lookup within the same two-attempt bound. The identical socket error after provider handoff cannot enter this recovery path.

## Pros and Cons of the Options

Immediate termination avoids recovery work but exposes a complete atomic step to transient failures before HTTP transmission. SDK retries and whole-step repetition can duplicate already charged model work or resample semantic decisions. Connector recovery cannot resend a response-bearing request because the HTTP client receives no socket until establishment succeeds, but it can add another connection wait and does not solve failures after handoff. Its usefulness and latency still require complete-world evidence.

## Links

- [Full-step contract](../specs/0026-full-step-efficiency-experiment.md)
- [Account-scoped DNS](0107-account-scoped-https-dns.md)
- [Connector and real socket regressions](../../src/engine/models/__tests__/model-connector.test.ts)
- [Undici 7.29.0 connector callback boundary](https://github.com/nodejs/undici/blob/v7.29.0/lib/core/connect.js)
