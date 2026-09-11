# Transition Current-Interval Assessment

Artifact-Version: 1
Status: Approved

## Intent

Within [0029](0029-nonthinking-gameplay-efficiency-experiment.md), address formally valid transition summaries that describe gated future work as current progress. An active goal Activity represents the whole attempt and may include waiting; continuation invariants are onset-true conditions, not future activation predicates. Preserve these runtime contracts.

## Contract

In the unpromoted transition worklist wire, replace the summary field with a model-authored intervalAssessment containing gates, currentWork and pendingWork. currentWork restores the canonical summary verbatim. Each gate identifies an exact substring of its original action, a requirement, satisfied/pending/unknown state, and at least one exact source-value citation using a JSON Pointer. Its citation root includes the action's participant entities, input facts, placement ancestry, temporal boundary and slotContext: the complete original logical slot reconstructed from shared state and its own delta and catalog order. This reference retains access to relevant original evidence outside the additional participant view without duplicating it or granting another slot's permissions. Reject incorrect quotations, pointers, values, missing assessment fields and conflicting canonical summary fields. Invalid rows remain invalid for canonical slot-local rejection; valid neighbors survive. Raw request/response evidence retains every assessment.

Gate relevance, semantic entailment and completeness remain model judgments. Mechanical evidence matching is not a semantic oracle or permission to change state. Preserve all canonical outcomes, action indices, assertion variants, effects, reference scopes and source information. The model must distinguish actual interval work from pending compound subtasks, without automatically making every action wait or fabricating effects. Do not infer an output field, status, prerequisite or assertion in the codec. No additional planner, critic or model call is introduced; thinking remains disabled and all generation parameters remain fixed.

## Plan

Freeze a new complete twelve-slot/forty-three-action source diagnostic after focused and full checks. Keep [0054](0054-transition-catalog-prefix.md) input representation, the original at-most-two-HTTP ceiling and STEP-E2 budget. Count extra output tokens and latency. Formal evidence fidelity permits independent source-semantic review only. Any failure or unresolved prerequisite prevents gameplay promotion; prior failed trials remain closed.

## Verification

Test exact source quotation, escaped JSON Pointers, scalar and structured values, foreign/missing references, tampered evidence, unknown prerequisites, empty legitimate gates and conflicting fields. Verify currentWork restoration without modifying the model's wording, retention of all original effect arrays, and invalid-neighbor rejection through the actual coordinator/gateway. Check the complete actual token budget before each request and run check:fast before committing.

## Evidence

[Interval assessment tests](../../src/engine/mechanics/__tests__/transition-interval-assessment.test.ts) cover source fidelity and schema conversion. [Worklist gateway tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) cover actual output recovery. The local experiment record owns frozen source requests, model responses, cost attribution and independent semantic findings; this representation does not establish open-semantic correctness.
