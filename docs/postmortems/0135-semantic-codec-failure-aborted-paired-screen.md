# Semantic codec failure aborted a paired screen

Artifact-Version: 1

## Executive summary

A diagnostic codec classified invalid model content as a transport failure, aborting an otherwise bounded paired experiment. Typed gateway regressions and independent physical request identities now protect rejection accounting and recovery.

## Summary

The semantic-draft diagnostic stopped after fifteen of twenty planned HTTP calls. A completed candidate response selected an unavailable evidence reference. Its codec rejected the response with a generic Error, which the provider classified as a transport failure. The runner settled the current wave but aborted before the final five control calls. The candidate was already semantically unqualified, so the terminal trial is retained without replacement sampling.

## Timeline

- The initial gateway regression accepted any exception from invalid draft outputs.
- Full checks passed and the first semantic-draft screen dispatched on a committed producer.
- The second candidate wave returned an unavailable evidence reference; its generic codec error aborted later dispatch.
- Recovery retained all fifteen complete SSE responses and exposed the shared source invocation identity.
- The corrected gateway regression requires output-error identity and retained billable usage; each probe event now carries an independent request ID.

## Root cause

The provider's completed-output boundary recognizes ModelOutputError and schema errors as billable output rejection. Generic errors are reserved for execution failures. The new codec threw generic errors for model-owned assignment and evidence mistakes. Tests checked only that invalid drafts threw, allowing the wrong error taxonomy to pass. Consequently the failed response had no per-entry result/audit file, although the aggregate raw SSE response remained available.

Frozen source replay also reuses the source's public model invocation identity. That identity alone cannot join concurrent experimental arms to raw responses. A recovery attempt using only it initially selected the wrong response. Complete SSE content, sequence and provider response identities recover all fifteen completed responses, including the rejected draft; the mistaken lookup is explicitly labeled and is not evidence for that candidate.

The final paired order is incomplete; no B/C/C/B efficacy claim is available. All fifteen model responses remain billable. Neither a world step nor a player result was committed, and no production composition used the draft task. Simpler-schema acceptance does not erase the candidate's future-information and onset counterexamples.

## Guardrails

- The [draft codec](../../src/engine/benchmarks/step-efficiency/perception-semantic-draft.ts) raises ModelOutputError with the untouched raw value for model-owned relation failures; changed source configuration remains fatal.
- The [gateway regression](../../src/engine/benchmarks/step-efficiency/__tests__/perception-semantic-draft.test.ts) checks the exact output-error category, raw rejected value and retained billable completion rather than only expecting an exception.
- The [probe runner](../../scripts/experiments/player-perception-check-probe.ts) labels every runtime event with its physical probeRequestId and saves a per-entry fatal record before aborting. Frozen invocation identity is preserved independently.

## Verification

Exercise invalid assignment, unknown evidence and canonical-as-draft responses through the actual gateway with a scripted network boundary; assert typed rejection and usage retention. Run the focused regression and check:fast before the correction commit. Do not rewrite the original trial as completed or launch its missing requests under a changed producer.
