# Semantic plan repairs bypassed batching

Artifact-Version: 1

## Executive summary

TruthEngine issued independent semantic plan repairs concurrently, but their dedicated schema name was absent from the batch coordinator's admission table. Each repair sent the complete world separately. An explicit shared-batching option admits the existing repair result schema while retaining each logical scope.

## Summary

A complete-world diagnostic included four known-response semantic plan repair HTTP requests with roughly 379–380 thousand input tokens apiece. These calls followed plan-verifier findings and carried distinct single-action responsibilities. Other canceled logical calls are not counted as completed HTTP requests. This transport cost is separate from the validity of the reviewer findings and the trajectory's earlier terminal reference error.

## Timeline

- TruthEngine generated targeted plan repairs with Promise.all after semantic verification.
- The coordinator admitted initial plan commits and verifier calls but excluded the dedicated plan-repair schema.
- Recorded requests showed repeated full contexts despite concurrent generation.
- A registered game-step comparison reproduced two separate repairs with the option absent and one physical batch with it selected.

## Root cause

Logical recovery specialization was not propagated into physical schema admission. The scoped repair and initial planning results share the same canonical commit_plans contract, but only the initial schema name reached the collector. Concurrency configuration and tests of initial planning did not exercise this path.

## Guardrails

The [registered game-step test](../../scripts/operations/step-plan-repair-batching.test.ts) triggers actual semantic repair, compares reconstructed contexts and resulting world state, and verifies replay. [Coordinator tests](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) cover exact scoped evidence, malformed-neighbor delivery and incompatible boundaries. The [opt-in contract](../specs/0085-scoped-plan-repair-batching.md) requires fresh model evidence before any semantic or gameplay claim. No review is skipped and no existing result is reclassified as successful.
