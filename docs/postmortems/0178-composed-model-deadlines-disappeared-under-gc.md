# Composed model deadlines disappeared under garbage collection

Artifact-Version: 1

## Executive summary

Real-model acceptance left unfinished model work active under heavy local allocation pressure. Independent HTTP reproductions showed that composed timeout signals could lose their timeout source during garbage collection on Node 23.11.0. The request then remained pending and occupied a scheduler permit. Model adapters own their controller and timer through complete transport settlement; native TypeSafe response reads also explicitly cancel and drain the body reader. This restores the configured deadline without changing model semantics, batching, retry policy or profiles.

## Summary

The funded twelve-origin acceptance run exposed active invocations with no recorded retry or completed output while local instance reads were also under pressure. Ledger lookup and inspection identified the affected requests, and the integrity doctor reported no missing or orphaned evidence. Event timestamps are persistence times for buffered events; their gaps do not establish time spent in the provider, transport or queue. The separate read-cache investigation is recorded in [postmortem 0177](0177-local-read-cache-thrashing-stalled-gameplay.md). The earlier exhausted-credit failures were distinct and retained separately.

A controlled Node process isolated signal lifetime from model generation. With a 150 ms deadline and forced garbage collection, an unretained `AbortSignal.timeout` source inside `AbortSignal.any` failed to fire by 300 ms in all four repetitions. A directly retained timeout, an explicitly retained composed source and an owned controller/timer each fired in all four repetitions. The real Gateway, scheduler, adapters and AI SDK then reproduced stalled local HTTP calls with a 1,000 ms profile deadline. These fixtures establish a cancellation failure under the tested runtime; they do not establish that garbage collection caused every unfinished production invocation or measure real-model performance.

## Timeline

- On 2026-10-17, real-model acceptance was paused after active work and slow local reads prevented reliable gameplay verification. The first failed runs and their Ledger evidence were retained.
- Standalone native and Next request-fetch probes used local HTTP responses that stalled before headers or during a response body. Under forced garbage collection, eight timeout cases remained active with one occupied permit and one queued request; caller-cancel and success controls completed.
- The pure Node signal-lifetime matrix isolated disappearance of an unretained timeout source. Development fetch patching was not required for this reproduction.
- An independent temporary copy replaced timeout composition with an owned deadline. SSE calls completed cancellation and released the queue. TypeSafe still stalled inside its complete body read after the input signal had aborted, so its response reader gained explicit cancellation and drainage.
- The permanent child-process fixture failed against the original SSE and TypeSafe adapters with `active=1` and `queued=1`. The corrected fixture passed timeout, caller-cancel and success cases for SSE, non-streaming JSON and TypeSafe, including response closure, queued progress, usage and deadline cleanup.

## Root cause

The generative adapter delegated its total timeout to the AI SDK. The SDK composed the caller signal with a locally created `AbortSignal.timeout` source using `AbortSignal.any`; the native TypeSafe adapter used the same composition directly. In the tested Node runtime, the composite's weak references did not keep that timeout source alive through collection. An outstanding network request and its caller signal could remain reachable while the deadline disappeared. A pending transport kept the scheduler's permit, so other requests could remain queued indefinitely. Existing cancellation tests used immediate mocked responses or explicit caller aborts and did not collect an ephemeral timeout source during a real blocked response.

The TypeSafe entry path exposed a second cleanup boundary: its fetch signal could abort while `response.text()` remained pending after headers. Direct native-fetch controls did not reproduce that behavior, so the evidence is limited to the exercised adapter call chain. Explicit reader cancellation closes that boundary and waits for cancellation before the adapter settles. Non-streaming generative responses also exercise diagnostic `response.clone().text()`; the same controlled test passes with the owned signal, so that path needs no separate change.

The fix does not race an unresolved transport against a timer. The timer aborts an owned controller, the actual adapter work drains, and only then can the Gateway release its permit. Deadline failure retains `TimeoutError`; caller cancellation retains its own reason. Completion clears both the timer and caller listener. Successful parsing, response identity, usage capture and the existing transport retry policy remain unchanged.

## Guardrails

- The [owned deadline and body reader](../../src/engine/models/model-request-deadline.ts) retain cancellation ownership until the [generative adapter](../../src/engine/models/model-adapter.ts) or [TypeSafe adapter](../../src/engine/models/typesafe-adapter.ts) settles. The registry's separate owned deadline remains independent.
- The [permanent deadline regression](../../src/engine/models/__tests__/model-deadline.test.ts) launches the [real Gateway HTTP fixture](../../src/engine/models/__tests__/fixtures/model-deadline-probe.ts) in a child with `--expose-gc`. It covers SSE, non-streaming JSON and TypeSafe; timeout and caller abort; successful cleanup; response and interrupted-socket closure; unchanged usage; and progress of a request queued behind a single permit. Caller cancellation is tested with retries enabled and still sends no retry.
- Existing [provider regressions](../../src/engine/models/__tests__/model-provider.test.ts) and [decision entry tests](../../src/engine/models/__tests__/decision-v2.test.ts) continue to cover successful transport, validation and audit behavior. The [Gateway contract](../game-design/model-gateway.md#调度失败与审计) owns deadline and scheduling behavior.
- Controlled HTTP responses verify transport mechanics, not semantic model quality. Interrupted gameplay remains incomplete until a fresh real-model acceptance run verifies its published narrative and committed world state.
