# Blind Physical Batch Retries

Artifact-Version: 1

## Executive summary

Malformed physical batch responses triggered identical requests without the failed output or validation issues. Repeated structural failures then split the batch, increasing calls while hiding the actionable error from the model.

## Summary

STEP-E1 full-world runs recorded repeated malformed slot envelopes in resolution, transition and observation work. The experiment record owns the request hashes, costs and outcome limits. Structural feedback addresses a confirmed blind retry path; whether it improves paid model behavior requires full-runtime evidence.

## Timeline

- A provider response could not be parsed or could not identify every required slot exactly once.
- The coordinator retained the pending logical tasks but discarded the error and previous output when rebuilding its retry.
- After the fixed structural retry allowance, it bisected the same tasks into smaller physical batches.
- Real coordinator regressions demonstrated that both malformed JSON and incomplete slot coverage reached a second request without any feedback.

## Root cause

The recursive retry carried only task entries, attempt count and split path. Schema repair within a valid logical slot had its own error context, but malformed physical envelopes never reached that path. Repetition was counted as repair despite the model receiving no information about the failed attempt.

## Guardrails

The [batch coordinator](../../src/engine/mechanics/truth-batch-provider.ts) binds each structural retry to its preceding invocation, exact previous output, validation issues and expected slot numbers. The complete original task and reference contexts remain unchanged. The failed output is explicitly data, not additional world evidence or instructions. Retry limits, transport behavior and validation remain unchanged; feedback size participates in the existing input-size gate.

When a batch splits, each child receives only its original tasks and starts without the parent's cross-slot feedback. The [coordinator regressions](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) exercise malformed JSON and missing slot coverage, verify exact reconstruction of all original contexts, and preserve the bounded split-to-singleton behavior. Valid logical slots retain their existing salvage and targeted repair paths.
