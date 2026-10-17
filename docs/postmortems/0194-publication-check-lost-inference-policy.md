# Publication policy drift and a rejected native profile

Artifact-Version: 1

## Executive summary

Cost-controlled play revealed conflicting documentation about narrative publication thinking. The runtime and accepted decision deliberately enabled low thinking, while the narrative reference claimed disabled thinking. Reviewing a task-specific cost reduction also exposed a native-adapter mismatch that lower-level fallback tests did not exercise.

## Summary

The publication requests inspected in instance `c0c964d2-c158-4098-903e-0338726c9e86` used `deepseek-flash` with thinking enabled and low effort. Complete saved requests, responses and usage established the effective settings; the profile name alone could not establish the policy. The independent time investigation found correct elapsed receipts and an immutable published prefix, so added reasoning did not prevent the observed repeated-time continuation failure.

Git history shows the override introduced in `0edbe83b` and deliberately removed in `d81811cc`, alongside a changed expectation that publication inherit the profile and [decision 0236](../decisions/0236-reasoning-for-language-boundaries.md). The initial diagnosis treated the stale narrative reference as authoritative and called this an omitted argument; full decision review corrected that conclusion. There is no evidence of a rebase conflict. A bounded trial of disabled thinking did not qualify the alternative; [0265](../decisions/0265-disable-reasoning-for-publication-comparison.md) records its rejection and retains the established profile policy.

## Timeline

1. A bounded live run saved all requests and stopped after a narrative fallback.
2. Source review found a mismatch between the publication reference and both the actual call to `executeDecisionV2` and its accepted decision.
3. Inspection confirmed thinking was enabled on the real publication requests.
4. A regression through the publication entry point exposed a second mismatch: the native adapter accepted the default decision prompt but rejected the registered publication prompt before HTTP dispatch.

## Root cause

The inference policy had two conflicting documentation owners. The underlying decision executor correctly propagated a supplied language-model override and ignored it for native transport; the caller and its tests followed the accepted decision to inherit the generative profile. The narrative reference failed to follow that change. A green suite could not establish that the prose matched the deliberate configuration, and a single stale reference could not establish the intended policy.

Native fallback tests constructed requests directly at the generic decision layer. They did not pass the publication prompt through `checkNarrativeGrounding`, so they missed the adapter's stricter default-prompt identity check and its use of the default wire policy. A supported instruction profile could therefore fail before reaching either native evaluation or its context-limit fallback.

## Guardrails

[Publication entry-point tests](../../src/server/__tests__/world-narrative.test.ts) inspect actual HTTP payloads and audits: language checks retain their configured profile and all six questions, native requests retain native inference settings, and a real native context-limit response preserves the same state and questions in language fallback. The same entry rejects unregistered or mismatched prompt identities before transport. [The native adapter](../../src/engine/models/typesafe-adapter.ts) recognizes only the registered default and publication profiles and uses the selected profile's wire policy.

The [narrative reference](../game-design/narrative.md) owns the effective publication policy; the gateway reference links to it, and [0265](../decisions/0265-disable-reasoning-for-publication-comparison.md) retains the rejected cost and quality tradeoff. These checks establish configuration and evidence preservation, not equal model quality or natural-play success. Live usage must include failed drafts, native calls and language fallbacks rather than assuming all work uses the visible default model.
