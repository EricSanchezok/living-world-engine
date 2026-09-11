# Complete Context Window Admission

Artifact-Version: 1

## Executive summary

A complete transition diagnostic passed the gateway's input byte limit but the provider rejected it because its input tokens plus configured output limit exceeded the model's total context window. No generated result or usage was returned. The request remains closed with its full unknown-billing reservation retained.

## Summary

The provider reported 926939 message tokens and131072 requested output tokens against a1048576 window. Checking a4MB input ceiling did not establish token-window compatibility. The experiment transport then attempted to parse absent usage before exposing the HTTP400 error, and a subsequent stopped repair obscured the original failure in the summary.

## Timeline

- Participant-state evidence was added without removing the original complete context.
- An offline gateway check validated byte limits and reached the mocked send boundary.
- The provider rejected the actual request before returning a model result.
- Raw evidence identified total context overflow; accounting review quarantined the full reservation without assuming zero billing or reopening the trial.
- The transport preserves the explicit provider error, and source diagnostics treat integrity failures as terminal rather than repairable schema errors.
- The source launcher counts complete messages with a pinned public tokenizer and preserves the configured output budget in a prospective admission check.

## Root cause

Byte size, input token allowance, output token allowance and total context window are different constraints. The preflight checked only the first. Separately, unconditional usage parsing hid a useful provider rejection behind a missing-field error. Larger evidence views exposed both weaknesses.

## Guardrails

The [context admission check](../../scripts/experiments/deepseek-context-admission.ts) binds the public tokenizer fingerprint, runtime version and actual request body, adds a1024-token protocol allowance and rejects an over-limit body before reservation and HTTP. The [boundary tests](../../scripts/experiments/deepseek-context-admission.test.ts) cover the recorded overflow and exact capacity boundary. [Transport regressions](../../src/engine/benchmarks/action-compilation/experiment-transport.test.ts) preserve a provider400 and its unknown reservation without retrying. [Cost attribution](../../scripts/experiments/step-cost-attribution.ts) counts quarantined sends separately from known usage. [Spec0053](../specs/0053-transition-schema-references.md) governs exact schema-reference compaction without deleting arbitrary-JSON definitions or changing generation limits. Public tokenization plus an allowance remains a calibrated preflight, not a guarantee for every future hosted model revision.
