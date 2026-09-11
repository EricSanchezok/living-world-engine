# Single Transition Lost Its Evidence Layout

Artifact-Version: 1

## Executive summary

A failed multi-component transition entered logical repair as one physical request containing twenty-four actions. That path retained the original world data but bypassed the per-action evidence view and explicit output cardinality used by the indexed physical path. Formal recovery and source-semantic reliability remained separate problems.

## Summary

The integrated diagnostic's initial transition had an unknown fact reference. After candidate feedback was restored under [0079](0079-transition-loop-omitted-candidate-feedback.md), bounded repairs alternated between missing root arrays and empty outcomes. A separate example-omission pair failed both arms. A feedback-position pair passed formal coverage in both arms but produced unsupported contact or altered action order/audience. Neither pair established a layout advantage or a playable world step.

## Timeline

- The physical transition path gained a source-owned action worklist with participant state, facts, plans, receipts and temporal evidence.
- The coordinator preserved its canonical path for a group containing one logical component, including repair.
- Actual request inspection found that this canonical component contained twenty-four actions, while its schema still allowed an empty outcomes array and its evidence lacked the derived per-action view.
- Independent probes separated candidate-feedback, example and layout hypotheses without reclassifying historical failures.
- Canonical requests adopted the shared evidence extractor, existing coverage constraints and reversible assertion schema definitions; fresh integrated behavior remained to be tested.

## Root cause

Adapters selected behavior by the physical batch schema name. The canonical schema name therefore bypassed transformations even when the logical component contained many actions. Tests asserted unchanged singleton rendering but did not compare evidence relationships across physical and canonical paths. Restoring the raw state and rejected candidate did not restore this layout contract. The code discontinuity is established; its contribution to stochastic model failures is not established by a single positive or negative response.

## Guardrails

- [Transition evidence tests](../../src/engine/mechanics/__tests__/transition-evidence-worklist.test.ts) compare the same source row across both paths, retain exact candidate feedback and exercise one HTTP per canonical request through the real coordinator and gateway.
- [Canonical preflight](../../scripts/experiments/step-canonical-transition-preflight.ts) proves complete source restoration and measures both original and changed HTTP bodies with the pinned tokenizer. It reports added input rather than assuming net savings.
- [Specification 0063](../specs/0063-canonical-transition-evidence.md) binds fresh runtime identity and keeps full validation, semantic review, costs and gameplay acceptance separate from mechanical proof.
