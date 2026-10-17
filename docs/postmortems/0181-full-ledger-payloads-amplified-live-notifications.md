# Full Ledger payloads amplified live notifications

Artifact-Version: 1

## Executive summary

Real-model acceptance exposed severe local allocation pressure and slow interactive turns. Offline replay of the recorded event bodies isolated one avoidable cost: every live listener received a deep copy of the complete event before filtering by instance, and Inspector copied it again before discarding the body. Live summary subscriptions filter before copying and exclude payload bodies. Complete Ledger queries and full-event subscriptions retain their existing contents and isolation.

## Summary

The preserved lead execution contained 147 events, 30 recorded flush groups and 20,758,240 serialized payload bytes. A no-network reproduction created six real WorldHost instances, replayed those complete event bodies through trace emission and SQLite persistence, and opened one play stream and one Inspector stream per instance. Six lanes with twelve streams took 7.874 seconds, compared with 3.524 seconds without streams. Notification event copies consumed 4.568 seconds and copied a payload 4,704 times. The revised path took 3.326 seconds with streams and copied no payload for notification subscribers; event-copy time was 13.27 milliseconds. Both versions delivered 882 Inspector summaries and 882 play notifications, and their six canonical state hashes remained unchanged.

These are independent-process, synchronous replay measurements, not provider timings or a complete interactive benchmark. They establish a reproducible subscription amplification and its removal. They do not explain every production timeout or qualify the twelve-origin game. The earlier CPU profile's apparent 17.47-second anonymous-listener cost was entirely its first sampling interval; that interval is not evidence that the callback ran continuously for 17 seconds and is excluded from attribution. In the remaining 5.032 seconds of samples, publication accounted for 54 milliseconds inclusive, while instance reads, definition loading and garbage collection were substantial. The six-stream experiment therefore demonstrates an independent amplification; it does not reclassify that historical profile as a notification bottleneck.

## Timeline

- The integrity doctor found 5,913 indexed events with no missing rows, orphaned artifacts or warnings. Invocation lookup and inspection identified the preserved lead execution and its event bodies.
- The matching archived Next chunk mapped the suspicious anonymous frame to WorldHost's three cache-invalidation map deletions. The callback did not read or copy a complete instance document.
- An offline real-host regression observed 84 unnecessary payload-bearing event copies for six matching payload events while no instance document was copied. A recorded-body replay quantified the fanout separately from persistence and provider work.
- Summary subscriptions removed full bodies before isolation copies and applied instance filters first. Existing full subscriptions and explicit full-payload reads remained available. Focused tests verified ordered delivery, unsubscribe, mutation and exception isolation, payload presence including null, and unchanged canonical state.

## Root cause

The full-event listener API served both audit consumers and UI invalidation consumers. LocalDatabase deep-cloned every persisted event for every listener. WorldHost then filtered by `instanceId`, so an unrelated open stream paid for a full model context or response copy that it would immediately ignore. Inspector's summary helper cloned the whole event before removing `payload`, repeating the expensive work for the matching stream. Cost therefore grew with both event payload volume and the number of open streams; no canonical history rebuild was required for this amplification.

The distinction is notification projection versus durable evidence. Summary subscribers receive the same scalar metadata, correlation, sequence and `hasPayload` flag needed by Inspector and play invalidation. Each matching subscriber receives an isolated metadata copy; exceptions cannot alter persistence or later listeners. Full audit consumers still receive isolated full events. Payload lookup and replay continue to read complete persisted artifacts. No model prompt, batch cardinality, context content, call count, profile, canonical state or save format changes.

## Guardrails

- [LocalDatabase](../../src/server/local-database.ts) filters summary subscriptions before copying and omits bodies from their projection. The [Ledger interface](../../src/server/execution-ledger.ts) distinguishes full events from live summaries; [WorldHost](../../src/server/world-host.ts) uses summaries for invalidation and stream delivery.
- [Inspector projection](../../src/server/world-inspector.ts) removes a full event's body before cloning metadata. Explicit detail and artifact queries retain full payloads.
- The [six-instance host regression](../../src/server/__tests__/world-host-subscriptions.test.ts) verifies zero notification payload copies, per-instance ordered output, unchanged state, full-body query availability and unsubscribe. The [Ledger regression](../../src/server/__tests__/execution-ledger.test.ts) verifies filtering before copies, independent mutable deliveries and failure isolation for summary and full consumers.
- The [observability reference](../game-design/runtime-observability.md#inspector) owns the projection boundary. Performance measurements are evidence, not hardware-dependent CI thresholds. Full gameplay and provider latency remain separate acceptance questions.
