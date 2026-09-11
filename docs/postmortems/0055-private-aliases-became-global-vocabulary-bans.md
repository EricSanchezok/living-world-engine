# Private Aliases Became Global Vocabulary Bans

Artifact-Version: 1

## Executive summary

The full-world observation validator rejected ordinary vocabulary because another Agent used the same word as a private local entity ID. This caused repeated paid repairs despite correct identifier scoping in the model output.

## Summary

Trajectory 14 compiled 48 actions in four initial calls without repair. Its first shared observation output then produced seven information-boundary rejections, Ledger sequences 969–975. A source-bound base-state diagnostic identified the matched tokens `keep`, `grain`, `warriors`, `collector`, `father`, `family` and `column`. For example, another Agent's alias `keep` collided with an ealdorman's instruction to "keep watch". The diagnostic is not a complete transitioned-state replay or an unrestricted semantic judgment.

## Timeline

The shared-context candidate reached observation rendering. Repeated information-boundary errors triggered bounded repairs. Inspection identified the alias owners and ordinary-word collisions, and the operator stopped future requests while draining active work. The trial retained zero commits, 85 returned HTTP requests, known estimated cost CNY 64.268901568 and no new unknown billing. Historical errors, output and costs remain preserved in the STEP-E1 evidence directory.

## Root cause

The guard aggregated bare local entity IDs from every other Agent into a global protected-token set. Word-boundary matching fixed substrings but retained the incorrect global namespace assumption. A local-entity-valued claim repeated the same mistake.

## Guardrails

The [owner-scoped identifier decision](../decisions/0114-owner-scoped-local-information-identifiers.md) defines the corrected boundary. The [guard tests](../../src/engine/cognition/__tests__/information-boundary.test.ts) permit ordinary vocabulary while rejecting foreign qualified references, even when the observer owns the same bare alias. They preserve canonical-identifier boundaries and private-text checks. The [guard](../../src/engine/cognition/information-boundary.ts) derives qualified handles with the existing reference constructor, without a world-specific vocabulary list or output rewrite.

Re-evaluating the same nine raw packets against the same base state removed all seven alias collisions. Full rendering, committed state, semantic consequences and complete-game cost still require separate validation; the fixed literal screen alone is not gameplay acceptance.
