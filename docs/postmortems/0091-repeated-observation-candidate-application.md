# Repeated Observation Candidate Application

Artifact-Version: 1

## Executive summary

A 48-Agent deterministic three-step run exposed growing local execution time despite zero model repairs or remote calls. Observation rendering repeatedly applied the same proposal to a complete simulation snapshot for every observer and again when validating and returning accepted drafts.

## Summary

Request generation applied the proposal once per observer. Observation materialization applied it twice, and the successful return repeated that materialization after validation. A successful observer therefore required five identical candidate applications. Historical state growth amplified the copying and validation cost.

## Timeline

- A final-candidate integration run completed three deterministic steps with increasing local time and audit input bytes.
- Isolated instrumentation measured serialization, sorting and cloning, then attributed slow clones to their actual call stacks.
- The third step spent roughly 1.5 seconds cloning simulation state on observation-rendering call paths, before counting repeated validation and reference work.
- Source inspection identified redundant candidate application and successful-draft rematerialization.

## Root cause

Observer-specific projection and validation each reconstructed a shared immutable world candidate. The semantic repair loop discarded the already validated packet, requiring an identical second conversion on success. Neither repeated operation added new evidence or changed the candidate.

## Guardrails

A rendering call owns one detached input snapshot and one applied candidate shared across its observer slots and repairs. Observer projections and private reference resolvers remain separate. The validated packet is retained on success; rejected drafts cannot leave a cached accepted packet. No snapshot survives the rendering call, and a subsequent call reconstructs its own candidate.

[Observation tests](../../src/engine/cognition/__tests__/observation-renderer.test.ts) verify snapshot stability during repair, observer ownership, protected-information rejection and bounded fallback. [Final-candidate tests](../../src/engine/algorithms/eager-reference/__tests__/final-candidate-review.test.ts) retain exact final review and atomic commit coverage. Local before/after experiments compare all request hashes, bytes and committed semantic hashes; timing remains a local implementation measurement rather than a remote-model gameplay claim.
