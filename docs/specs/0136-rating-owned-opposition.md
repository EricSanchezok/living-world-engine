# Rating-Owned Opposition

Artifact-Version: 1
Status: Approved

## Intent

Reduce first-response opposed-rating ownership errors under the complete-player objective in [0122](0122-player-action-efficiency.md), without inferring the intended adversary or weakening source validation.

## Contract

An independently configured physical planning adapter adds a complete flat projection of eligible existing ratings, their displayed entity owners, values, labels and original source slots. An opposed difficulty may explicitly emit targetRef null to select the entity owned by its selected ratingRef. The decoder restores that exact entity reference only when the rating and owner are available in the assigned action's original slot. Existing explicit targets remain unchanged, including incorrect pairings; missing fields are not completed. Unknown ratings and cross-slot selections remain rejected. The plan must still explicitly select its intended targets, and the original materializer owns target membership, rating ownership and all other mechanical constraints.

The adapter preserves every originally legal opposed combination, environment difficulty, actor rating, source, target order, effect, cause, factor and free text. It does not add the derived owner to the target list, change the selected rating, infer an opponent from prose or modify a historical rejected pairing. Source contexts, schemas and projected ownership bind the decoder. Valid neighboring slots retain independent results. Current-interval instructions survive the representation change. Gameplay compositions do not enable this experiment.

## Plan

Implement the flat ownership projection and explicit null convention after the existing physical planning codecs. Exercise the actual gateway, coordinator and original materializer. Replay complete recorded outputs without paid HTTP, preserving historical ownership failures. Freeze one B/C feasibility pair on the complete 49-action initial source: same current producer and temporal instructions, 11 slots, original context and domains, DeepSeek Flash with thinking disabled, one response per arm, at most two HTTP calls, one transport attempt per cell and a 240-second request bound. No repair, continuation, resampling or world execution is included.

## Verification

Verify all eligible owner/rating combinations, alias and slot permissions, missing or malformed fields, conflicting explicit targets, empty domains, source mutation, repeated targets and valid neighboring slots. Run relevant tests and check:fast before a local commit and dispatch. Record whether null opposition is actually exercised, all original-gateway and materializer failures, source-semantic counterexamples, complete tokens/cache/output volume and transport. A single feasibility pair cannot establish reliability or causal performance. Full-player adoption retains the original complete-world acceptance criteria.

## Evidence

[Decision 0189](../decisions/0189-select-opposition-through-rating-ownership.md) records alternatives. [The earlier relation experiment](0114-bind-planning-relation-choices.md) remains separate and disabled. [Interval settlement](0134-settle-interval-resolution-effects.md) remains authoritative.
