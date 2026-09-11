# Perception output escaped its task assignment

Artifact-Version: 1

## Executive summary

Perception checked individual references and numeric rules without checking that each generated check belonged to its explicit task. The fix adds task-relation validation and field-local repair diagnostics, while retaining independent semantic review.

## Summary

Real-model perception diagnostics admitted schema-valid, numerically valid check batches containing observer/source-action pairs outside the scheduler's explicit task. One admitted check described a dog noticing a boar herd while citing an action about a dragon searching for missing offspring. Earlier real trajectories exhausted repair after ownership errors that identified only a runtime check ID, without a draft path or its legal owner-bound choices.

## Timeline

- Focused assignments were validated and displayed to the model.
- A real trajectory exhausted repairs on generic actor-Rating ownership errors.
- A prospective owner-bound representation passed numeric validation for two batches containing unrelated observer/action pairs.
- Source review rejected both batches and identified the absent output-task intersection.
- Real-entry regressions bind output tasks and aggregate independent repair diagnostics before randomness.

## Root cause

The request carried validated task pairs, but output validation checked references, mechanical numbers and general causal scope without intersecting the check with those pairs. The consumer could ignore an unrelated check, while the perception stage still treated its batch as accepted. Materialization threw the first generic ownership error, concealing other independent errors from the same repair request.


The [task relation contract](../specs/0107-validate-perception-task-relations.md) validates output membership and collects precise ownership and independent materialization errors before RNG. It preserves additional causal evidence and open check meaning; a matching pair does not certify that the check's prose describes the right event.

## Guardrails

[Real-entry regressions](../../src/engine/mechanics/__tests__/perception-references.test.ts) exercise wrong observers/actions, empty and unfocused scopes, legal coalescing, complete repair diagnostics and identical accepted randomness. Source-semantic review remains necessary because identity and numeric validation cannot prove natural-language equivalence. Historical accepted mechanical results are retained with their subsequent semantic rejection, rather than relabelled as successful gameplay.
