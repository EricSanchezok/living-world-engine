# Retrieval Warmup Projection Mismatch

Artifact-Version: 1

## Executive summary

Cache preparation validated a different candidate representation from the production compiler, leaving most first-step encoding work on the gameplay path.

## Summary

The initial cache preflight passed while a real full-world compilation still encoded almost every candidate passage. In the recorded trajectory 12 compilation context, only 8 of 1775 production passages matched the warmup set. Trajectory 13 also spent several minutes preparing its first compilation and subsequently failed during TCP connection establishment; the cache mismatch is proven, but it does not by itself prove the cause of that network failure.

## Timeline

Full-world traces showed cold encoding after successful preflight. A source-bound passage comparison established the representation mismatch. Reusing the production constructor restored most exact matches, and a regression reached retrieval through the actual compiler entry point before the next game experiment.

## Root cause

The warmup assembled a raw reference catalog with canonical handle details. Retrieval consumes the compiler's projected catalog, where references use candidate keys and only selected candidates carry details. These produce different exact passage strings and therefore different cache entries. The preflight tested the warmup's own strings, so it could pass without exercising the production boundary.

## Guardrails

The [warmup](../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup.ts) uses the same context constructor as [compileActions](../../src/engine/algorithms/eager-reference/action-compiler.ts). The [runtime regression](../../src/server/__tests__/action-compilation-retrieval-runtime.test.ts) warms a fixture and reaches retrieval through compileActions with a real action, requiring its projected passages to be readable without new encoding. Existing exact-text, world and encoder fingerprints remain authoritative; no vector is reused for a different passage.

## Limits and evidence

On the same recorded context, projected warmup covered 1688 of 1775 passages. Arbitrary action text, batch combinations and evolving state can still create new passages; dynamic encoding remains required. The change does not alter candidate ranking, selection budgets, model inputs or game semantics. The source-bound diagnostic and complete-game validation are tracked in the STEP-E1 record. Cache coverage is not proof of gameplay success or network reliability.
