# Compilation recovery paths lost evidence

Artifact-Version: 1

## Executive summary

A full-world trial exhausted compilation recovery after valid audience selections were replaced with entity references during repair. Two recovery paths failed to preserve the evidence required by the existing compilation repair contract.

## Summary

The first response selected valid Agent audience references but paraphrased source-owned action text. The representation adapter rejected the entire attempt and discarded the decoded candidate from the in-memory repair error. The next request therefore contained a description diagnostic and no previous attempt. Its response introduced two entity audience references. Because another slot was structurally invalid, the compiler used schema localization, whose materializer exposed only the first reference-use error. The final response corrected that reference but retained the second. Strict validation prevented a world commit.

## Timeline

- Initial compilation selected Agent audiences and supplied a contradictory action description.
- The source-description guard rejected the whole attempt; repair received no previous output.
- Repair omitted the description, introduced two entity audiences and malformed several sibling slots.
- Schema localization reported one audience failure, although both were independently detectable.
- The remaining audience reference exhausted recovery; the player received no committed feedback.
- HTTP-substitution regressions reproduced missing previous output and incomplete reference diagnostics before the fixes.

## Root cause

The source-description guard intentionally prevented localized acceptance of contradictory text, but conflated rejection with removing the candidate from repair evidence. Separately, the complete reference traversal covered the ordinary compiler path but not a schema-valid slot recovered from a malformed physical batch. The latter called the fail-fast materializer directly. Tests covered valid physical batches and individual malformed outputs, but did not combine a malformed sibling with multiple independent reference failures.

## Guardrails

The [gateway regression](../../src/engine/algorithms/eager-reference/__tests__/compilation-repair-evidence.test.ts) drives both optional and omitted description schemas through the actual compiler, codec and HTTP serialization. It requires whole-attempt rejection, exact previous candidates and successful source-bound repair without accepting contradictory text. Its reference cases exercise both structurally valid and malformed physical batches, requiring all independent diagnostics with matching wire paths and aliases. The [complete repair contract](../specs/0068-complete-compilation-repair-evidence.md) and [source-description rejection policy](../decisions/0117-source-owned-activity-descriptions.md) remain authoritative.

## Limits

Complete evidence does not guarantee that a model repairs it correctly. These fixes preserve source ownership, candidate scopes, validation, model settings and recovery limits. Historical failed trials remain failures; deterministic recovery tests do not establish whole-world latency or semantic success.
