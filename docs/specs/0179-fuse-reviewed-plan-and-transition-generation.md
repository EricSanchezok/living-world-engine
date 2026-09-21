# Fuse Reviewed Plan and Transition Generation

Artifact-Version: 1
Status: Implemented

## Intent

Within the authorized autonomous [player efficiency experiment](0122-player-action-efficiency.md), test whether co-generating a complete initial plan and a provisional transition removes a serial inference without weakening world semantics. This is a diagnostic candidate; the complete 48-Agent-plus-human acceptance target remains unchanged.

## Contract

The candidate receives both complete planning and pre-commit transition contexts through the reversible shared-context codec. It returns the ordinary complete plans, each plan's existing additional-randomness declaration, and either a provisional transition or explicit deferral. Plans retain their original materializer and independent semantic review. The transition never supplies plan authority, random results, observer knowledge or an Agent policy decision.

Reuse requires one successful initial plan generation, one accepting plan review, unchanged source state and actions, no plan repair, no check or random commitment, and an explicit no-additional-randomness declaration for every plan. A deferred, repaired or stochastic proposal follows ordinary transition generation. Reuse consumes the exact model-authored transition once; it still passes the original transition schema, reference materializer, typed mechanics, receipt settlement, causal assertions, observations, final causal review and atomic commit. An invalid provisional transition enters the existing bounded transition repair path, retaining its original generating invocation as evidence. One co-generation HTTP request is counted once.

The experiment neither infers task success from an automatic receipt nor requires an event for every legitimate no-op. Qualification examines actual source-supported task achievement, including a grounded answer or obstacle for the external participant. A nominal success containing only clock advancement remains a failure for that inquiry. No source-semantic correctness follows from schema acceptance or a model review alone.

The frozen-source comparison preserves every original action, the complete world, component boundaries, batch limits, model and disabled-thinking setting. Imported initialization and preparation are identified as historical; only fresh HTTP is timed and billed. It cannot establish end-to-end player latency. A useful source result must be followed by fresh complete-player execution before promotion. All provisional outputs, deferrals, rejects, repairs and fallbacks remain in the evidence.

## Plan

Add the joint proposal contract at the Truth Engine's initial planning boundary, retain all downstream authorities, and expose it only through an explicitly pinned diagnostic Composition. Compare the diagnostic on complete recorded player-world inputs, then use the ordinary full-player runner for live qualification.

## Verification

Exercise actual Truth Engine preparation and completion: exact ordinary deterministic outcomes and RNG, rejection of forged references and missing outcomes, invalidation after plan repair or changed source, stochastic deferral, bounded transition repair, shared-batch coverage and one physical-call accounting. Run relevant tests and `npm run check:fast`. Fresh model results require independent source review and the full-player criteria above.

## Evidence

The shared context contract is implemented by [shared-batch-context.ts](../../src/engine/mechanics/shared-batch-context.ts). The original world validation boundary is [truth-engine.ts](../../src/engine/mechanics/truth-engine.ts). [Truth Engine regression evidence](../../src/engine/mechanics/__tests__/plan-transition-fusion.test.ts) covers full-world reference projection, complete-source invalidation, independent review, stochastic deferral and original-invocation repair accounting. The [frozen-source runner](../../scripts/experiments/player-truth-fusion.ts) reconstructs complete component inputs without inference; its separate run mode records fresh physical requests. Diagnostic implementation does not establish real-model speed or gameplay qualification.
