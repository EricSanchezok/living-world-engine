# Renamed onset checks rerolled fixed failures

Artifact-Version: 1

## Executive summary

The perception loop accepted a renamed copy of an already committed check and drew again for the same uncertainty. A failed perception became a success without any change in observer, source action, aptitude, difficulty, stakes or evidence. Unique request IDs did not enforce a fixed random commitment.

## Summary

A fresh actual-entry control used one authored perception check behind a translucent screen. The first model response requested that check and the engine committed a roll of 4 plus 3 against DC 10, failing. The continuation submitted the same request under a new proposalKey; its next roll was 8 plus 3, succeeding. The following request context contained both results. The diagnostic stopped before a third HTTP response, so this evidence demonstrates a repeated draw in preparation, not a committed world or a delivered false stimulus.

## Timeline

- A paired example-policy screen ran twenty cells through actual SimulationEngine preparation, replacing bootstrap, compilation and reaction model boundaries while using fresh perception responses.
- The baseline failed-check cell returned an exact repeated check after seeing failure; all ordinary reference and numeric validation passed.
- A zero-network regression reproduced both the renamed continuation and duplicate copies within one batch. An initial test fixture lacked invocation identity; correcting that fixture exposed the intended repeated-draw failures.
- The perception producer and frozen receipt validator share an exact commitment-content check before additional randomness or receipt acceptance.

## Root cause

The loop derived check IDs from round and ordinal. A new proposalKey therefore produced a different request identity even when the complete uncertainty was unchanged. The random primitive correctly drew for distinct request IDs, but the perception owner did not reject semantically identical request content. Instructions prohibited rerolling, while tests completed the phase after the first result or checked identity uniqueness rather than resubmission of the same uncertainty. A later successful check could be selected by a positive receipt without citing the original failure.

## Guardrails

The [perception commitment comparison](../../src/engine/mechanics/perception-commitments.ts) ignores request identity and disclosure while comparing exact uncertainty content; causal-reference order does not change that content. The [producer](../../src/engine/mechanics/truth-engine.ts) rejects duplicates within a batch or against prior committed checks, providing the existing check handle for targeted repair. It draws only after the complete proposed batch is accepted. The [receipt validator](../../src/engine/mechanics/onset-receipts.ts), also used by CanonicalCommitter, rejects a transcript containing repeated commitments even if a receipt selects only the later success.

The [real-stage regression](../../src/engine/mechanics/__tests__/perception-commitments.test.ts) verifies that repair retains the first failure and one RNG draw, rejects renamed and disclosure/reordering variants, rejects duplicate batches atomically, and preserves distinct uncertainty descriptions. The [receipt regression](../../src/engine/mechanics/__tests__/onset-receipts.test.ts) reproduces the failure-to-success transcript and rejects it without source or RNG mutation. These checks enforce exact repeated content; they do not prove that differently worded stakes are distinct uncertainties, and they do not certify natural-language perception semantics or player latency. The [onset contract](../specs/0128-observer-bound-onset-receipts.md) retains the broader semantic requirement.
