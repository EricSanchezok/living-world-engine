# Resumable Truth Candidates

Artifact-Version: 1
Status: Approved

## Intent

Expose a transition candidate before observation rendering and causal review while preserving the existing plan, random-commitment and transition-repair state. Final-candidate orchestration needs to repair a rejected component without rerunning its accepted plans or random draws.

## Contract

A Truth candidate session runs the existing preparation and transition validation path and yields an explicitly unreviewed resolution plus complete review evidence. It has no causal acceptance field and cannot satisfy the committed resolution contract. Yielded data is detached from the session's retained state. The consumer may request a bounded transition repair with the actual error and previous causal report, or finish the session. Finishing only closes candidate generation; it does not supply a semantic verdict.

Transition repairs preserve original actions, identities, plans, checks, discrete random results, receipts, acquisition/release ownership, repair limits and invocation lineage. Cancellation and terminal provider failures propagate without a fresh preparation or model retry. Closing a suspended session performs no model work.

The current resolve entry drives this same session, renders and validates observations, invokes the existing bound causal reviewer, performs existing targeted observation repairs, and returns a reviewed resolution only after acceptance. There is one transition implementation. Truth Role contract version 2 includes the session and bound-review capabilities; historical version 1 trees do not resolve under this changed interface. The stage extraction adds no model request, prompt change, context omission, thinking change, or candidate promotion.

## Plan

Extract the transition generator and route the existing entry through its session. Keep the existing observer-repair loop in the review driver. Expose the stage through the Truth Role capability for the subsequent step coordinator integration. Run focused entry-path regressions and check:fast, then commit locally with paid trials stopped.

## Verification

Through the real TruthEngine session and a substituted expensive model boundary, verify that preparation yields before observations or causal review, repair resumes without rerunning plans or RNG, mutation of a yielded candidate cannot change retained evidence, and closing the session creates no follow-up call. Existing step, targeted observer repair, mechanical repair, canonical replay, random concurrency and atomic failure tests must remain valid through the default driver.

## Limits

This unit enables final-candidate orchestration but does not yet move the step coordinator's global observation rendering. The gameplay objective and final-review coverage remain unproven. The preceding [bound review](0072-bound-causal-review-stage.md) and [random-stage release](0073-release-random-stream-after-commitments.md) contracts remain in force.

## Evidence

[Candidate-stage tests](../../src/engine/mechanics/__tests__/truth-candidate-stage.test.ts) own suspension and continuation behavior. [Resolution pipeline tests](../../src/engine/mechanics/__tests__/resolution-pipeline.test.ts) and [step tests](../../src/engine/algorithms/eager-reference/__tests__/eager-reference.test.ts) own the existing reviewed entry path.
