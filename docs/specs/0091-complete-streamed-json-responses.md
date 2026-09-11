# Complete streamed JSON responses

Artifact-Version: 1
Status: Approved

## Intent

Test native streaming as a response delivery option for long DeepSeek JSON generations after repeated peer socket closures. Existing autonomous experiment authorization covers this reversible opt-in and its bounded diagnostics. It does not approve stronger inference, automatic retry, partial output acceptance or default promotion.

## Contract

A model profile may select response_transport: deepseek-sse-v1 only for the DeepSeek OpenAI Chat JSON-object path. Use the installed SDK's native streaming call and request usage. System/user messages, JSON schema, action scope, generation parameters, thinking setting, timeout, semantic validators and commit boundary remain unchanged. The profile and actual HTTP evidence bind the selection. Unsupported combinations fail before HTTP.

Retain the complete original SSE response. Require consistent response identity/model, one choice, valid ordered content deltas, one terminal finish reason, reconciled final usage and the terminal DONE event. Reject malformed, unfinished, mixed-identity, repeated-terminal or post-terminal output. Do not parse partial text as model output. Preserve complete-response truncation and semantic rejection as measured failures with their incurred usage.

Experiment accounting explicitly selects the transport, verifies the actual stream and include_usage flags, and settles only a complete valid response with reliable usage. A socket failure or missing terminal evidence preserves its full unknown hold and stops subsequent sends. Disabled-thinking enforcement checks both reasoning deltas and usage. No network retry or response-dependent resampling is added.

## Plan

Use a maintained SSE parser for framing, the existing SDK for native streamed generation, and a shared completeness validator for runtime and experiment evidence. Add profile selection and actual HTTP tests before a separately frozen paid diagnostic of the recorded failed request. Keep prior failed trials closed and all their budget exposure.

## Verification

Exercise the real gateway and SDK with complete streamed JSON, comments, split UTF-8 and fragmented SSE boundaries. Compare actual request bodies after removing only stream/include_usage and compare canonical output and usage. Test missing DONE, missing usage, identity drift, duplicate finish, trailing content, malformed frames, socket interruption, reported reasoning, cancellation and unsupported modes. Preserve recorded raw SSE, exact partial bytes and full unknown reservations. Run focused checks and check:fast before committing. A live transport diagnostic cannot certify semantic correctness or gameplay.

## Evidence

[Decision 0154](../decisions/0154-native-streaming-for-long-json-responses.md) records the delivery choice and source documentation. The [model adapter](../../src/engine/models/model-adapter.ts) owns SDK invocation; [experiment transport](../../src/engine/benchmarks/action-compilation/experiment-transport.ts) owns experimental billing evidence.
