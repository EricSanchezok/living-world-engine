# Proportional budget rejected mandatory references

Artifact-Version: 1

## Executive summary

The production browser path could create a small world but failed its first step before model HTTP. Candidate retrieval required ten action, identity and temporal references while the proportional batch budget allowed only eight.

## Summary

Default-composition rollout exposed a conflict between a compression target and mandatory semantic references. The engine retried and split compilation work, but the fixed small catalog still could not satisfy the mandatory set. No canonical step committed. A unit test explicitly expected this rejection and therefore preserved the defect instead of exercising a playable small world.

## Timeline

- Production browser checks created observer and participant instances successfully.
- Their first advances stayed at step zero; Ledger integrity checks passed.
- The first anomalous event was `model.action_compilation.retrieval_failed`, before a provider request, with mandatory count ten and budget eight.
- Retrieval and browser regression coverage now exercise preservation of all mandatory references without requiring batch splitting or model repair.

## Root cause

The strict proportional shortlist budget applied to both optional ranked references and required semantic anchors. In a small catalog, required references can exceed twenty percent even though the absolute context is small. Rejecting that case makes the world unusable without offering a semantic recovery path.

## Guardrails

[Runtime v6](../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime.ts) uses the mandatory union as the minimum root budget. Relational RRF v2 pins the policy in its composition. Validation still rejects private, missing, duplicate and unscored references; repair reuses the same root selection. Diagnostics report nominal and effective budgets and whether the floor applied.

The [retrieval regression](../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime.test.ts) checks floor expansion, slot membership and unchanged ordinary-budget selection. The [browser flows](../../e2e/flows/immersive-game.spec.ts) exercise the production default through ordinary instance creation and advancement. [The rollout contract](../specs/0121-standard-integrated-execution-composition.md) owns this budget exception; old strict-ratio benchmark conclusions remain historical.
