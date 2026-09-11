# Observation Batch Prompt Conflict

Artifact-Version: 1

## Executive summary

The observation role's system and user instructions prohibited a batch wrapper even when the physical request supplied a batch schema. A shared-context coordinator appended the opposite instruction. This made an otherwise lossless representation ambiguous about output responsibility.

## Summary

STEP-E1 `probes-e1-shared-observation-01` reconstructed six original observation tasks without changing their contexts. Both shared responses returned only slot zero, while direct requests passed the finite reference and format screen in ten of twelve cases. The shared request hash is `5fc434e8efae899ad95d775fdd65caa7ced30ed1c4c80e649896705c3aea9377`. Omitted tasks do not establish a cost improvement. The conflict is directly observable in the request; the proportion of model failures caused by it requires a separate controlled probe.

## Timeline

After the six-observer shared-context probe failed, a separately frozen inference probe compared disabled and low thinking on the same unchanged body. Inspection during that probe found the contradictory system and user clauses. The inference probe retained its frozen body; prompt-fix evidence belongs to a separate trial.

## Root cause

The observation prompt treated a logical task and a physical HTTP request as the same unit. Its one-observer isolation rule became an unconditional prohibition on batch output. The coordinator changed the schema and added batch instructions but retained the conflicting role prompt, including the higher-authority system prohibition.

## Guardrails

The [role prompt](../../src/engine/prompts/system/observation-renderer.md) assigns one observer to each logical task and makes output packaging follow the supplied schema. Direct requests return one draft; batched requests return every numbered result, including no-change tasks. Each result retains its own authorized knowledge and references. The [user prompt](../../src/engine/prompts/user/observation-renderer.md) uses the same distinction. Prompt versions remain content-addressed, and no context, identity mapping, output validator or canonical state is changed.

The [coordinator regression](../../src/engine/mechanics/__tests__/truth-batch-provider.test.ts) composes the actual shipped prompt with six isolated tasks, checks exact context reconstruction and task-to-result mapping, rejects the conflicting clauses, and covers direct singleton dispatch. Simulated model responses establish the wiring only; separately frozen paid evidence is required for model efficacy and real WorldHost commits for gameplay acceptance.
