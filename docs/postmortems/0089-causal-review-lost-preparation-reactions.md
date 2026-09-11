# Causal Review Lost Preparation Reactions

Artifact-Version: 1

## Executive summary

A source-bound gameplay review found an accepted outcome claiming that another Agent had answered, although the actual reaction retained the original action. The causal reviewer received the candidate narrative and action set but not the reaction decisions already settled by step preparation.

## Summary

Missing evidence and reviewer accuracy are separate issues. Providing the actual decisions does not prove the reviewer will reject the unsupported statement. The same run also replaced observations after component review; correcting reaction delivery does not fix that later coverage defect.

## Timeline

- Step preparation collected model and external reaction decisions before component resolution.
- Component resolution closed its own reaction window and its local reaction list remained empty.
- Causal review projected actions and outcomes without the completed preparation decisions.
- Source inspection compared the accepted narrative with the durable keep decision and vetoed the technical commit.
- Real step regressions reproduced missing keep and replacement evidence in the causal review requests.

## Root cause

Reaction ownership moved to the step preparation phase without a corresponding evidence handoff to the component reviewer. Existing state and replay tests verified that replacement actions were executed, but did not inspect whether the reviewer could distinguish the Agent's actual decision from a proposed narrative about it.

## Guardrails

[Step tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) inspect actual causal review requests after keep and replacement decisions. [Context tests](../../src/engine/contracts/__tests__/activity-temporal-evidence.test.ts) distinguish unavailable and supplied-empty evidence, reject stale revisions, retain deferred replacement content and preserve surrounding context. [The contract](../specs/0071-causal-review-reaction-evidence.md) separates this input repair from unproven model accuracy and post-review observation coverage. The [source-review veto](../../src/engine/benchmarks/step-efficiency/trajectory-source-review.ts) remains required before gameplay acceptance.
