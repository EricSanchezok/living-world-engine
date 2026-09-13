# Standard Composition Player Baseline

Artifact-Version: 1
Status: Approved

## Intent

Measure the current standard composition through the same complete player entry used by [the integrated diagnostic](0122-player-action-efficiency.md). Recent complete-player failures use the frontier diagnostic composition; partial candidate screens do not establish which complete composition is more reliable.

## Contract

The existing full-player runner accepts an explicit standard or integrated composition selection at preparation. The manifest pins that selection and the complete algorithm reference; execution rejects either selection or reference drift. Default preparation remains integrated. Both use the same original forty-eight autonomous subjects, added external player, finite-work world recipe, source seed, player action, model snapshot, disabled thinking, retrieval runtime and persistence entry. No prepared model outputs or prior commitments are imported.

## Plan

After relevant checks and a clean local commit, prepare and run one standard-composition diagnostic through WorldHost. Keep the existing ceiling of 120 HTTP calls and ten minutes for new dispatch, settle in-flight work, and preserve all failed evidence. Verify the model bindings and exact prepared world identity before paid dispatch. Report bootstrap separately from submission-to-feedback, world commit and actual player completion. Review semantic outcomes before another player action.

## Verification

Use the registered standard algorithm reference and existing engine entry without adding a production adapter. Verify selection and composition hashes during preparation and execution, original world cardinality and disabled-thinking profiles, then run check:fast. Compare complete behavior to the previous integrated runs descriptively: independently generated NPC actions and service conditions prevent attributing a difference to one adapter. A single successful action would not establish near-zero repairs or general player reliability.

## Evidence

[Integrated player runner](../../scripts/experiments/player-integrated-playtest.ts) owns the complete execution and evidence collection. [Standard composition](../../src/engine/algorithms/standard-composition.ts) owns the baseline; the optional [integrated composition](../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm.ts) retains diagnostic qualification. This experiment adds a missing comparison, not a new algorithm or a default promotion.
