# Diagnostic wrapper lost the preparation producer

Artifact-Version: 1

## Executive summary

A diagnostic composition advertised its own producer while delegating execution to a separately constructed standard algorithm. Ordinary player submission passed, but a persisted external reaction exposed the inconsistent preparation identity. The host correctly rejected continuation before a world-step commit.

## Summary

The complete 49-Agent `integrated-player-03` diagnostic used 28 inference HTTP calls, including five repairs, and stopped without player feedback. Initialization and submission-to-stop together took 147 seconds; the external reaction appeared about 117 seconds after submission. These are failed-run measurements, not completed action latency. Source compilation and perception rejections preceded the independent producer-binding failure.

## Timeline

- Commit `555eff2b` passed 1,609 tests and the full fast checks. Its new WorldHost test exercised submission, persistence and reopening without an external reaction.
- Instance `22ae18be-8912-429a-a60b-2bd8cd83e622` prepared the step in execution `cf29bf1a-6d3d-4640-8fb1-670b00589d6c`. That execution succeeded by persisting a reaction preparation, without a commit revision.
- The player kept the proposed action. Child execution `a6c186c5-ad92-4511-9074-aa225da8d6b3` rejected the persisted preparation; Ledger sequence 494 records the failure. The complete instance evidence spans sequences 1–494, with no missing indexes or orphaned artifacts.
- An additional deterministic WorldHost case with an externally observable action reproduced the same `StepPreparationInvalidatedError` before the fix. The ordinary case continued to pass.

## Root cause

`integrated-player-diagnostic` version 1 wrapped an `eager-reference` instance. The wrapper's manifest identified the diagnostic composition, while `EagerReferenceAlgorithm.prepareStep` stored its own standard manifest hash. Immediate delegated completion compared two standard hashes and passed. Across a reaction window, WorldHost additionally compared the persisted preparation with the registered diagnostic producer and rejected it. The initial test checked the stored root and execution manifests, but never crossed the suspension boundary or inspected the internal preparation producer.

## Guardrails

The [composition factory](../../src/engine/algorithms/registry.ts) constructs the actual eager algorithm using the registered root and resolved children. Both the standard registration and diagnostic version 2 use this factory; the diagnostic only supplies its adapted model boundary. No saved preparation is rebound and no identity validation is weakened. Version 1 experimental instances remain historical failures.

The [player entry tests](../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm.test.ts) cover both immediate completion and an external reaction through real WorldHost persistence, automatic player `keep`, child execution, final feedback and reopening. They replace the expensive model and embedding boundaries; separate codec tests cover wire conversion. The [player acceptance contract](../specs/0122-player-action-efficiency.md) still requires fresh 49-Agent gameplay and source-semantic validation. Fixing this diagnostic defect does not resolve the observed model repairs or establish the latency target.
